/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { getWindow, n, ObserverNode, ObserverNodeWithElement } from '../../../../../../../base/browser/dom.js';
import { IMouseEvent, StandardMouseEvent } from '../../../../../../../base/browser/mouseEvent.js';
import { Emitter } from '../../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../../base/common/lifecycle.js';
import { IObservable, IReader, autorun, constObservable, derived, derivedDisposable, observableValue } from '../../../../../../../base/common/observable.js';
import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import { ICodeEditor } from '../../../../../../browser/editorBrowser.js';
import { observableCodeEditor } from '../../../../../../browser/observableCodeEditor.js';
import { Rect } from '../../../../../../common/core/2d/rect.js';
import { EmbeddedCodeEditorWidget } from '../../../../../../browser/widget/codeEditor/embeddedCodeEditorWidget.js';
import { Position } from '../../../../../../common/core/position.js';
import { Range } from '../../../../../../common/core/range.js';
import { IModelDeltaDecoration, ITextModel } from '../../../../../../common/model.js';
import { InlineCompletionContextKeys } from '../../../controller/inlineCompletionContextKeys.js';
import { IInlineEditsView, InlineEditTabAction } from '../inlineEditsViewInterface.js';
import { InlineEditWithChanges } from '../inlineEditWithChanges.js';
import { getContentRenderWidth, getContentSizeOfLines, maxContentWidthInRange, rectToProps } from '../utils/utils.js';
import { DetailedLineRangeMapping } from '../../../../../../common/diff/rangeMapping.js';
import { ModelDecorationOptions } from '../../../../../../common/model/textModel.js';
import { OffsetRange } from '../../../../../../common/core/ranges/offsetRange.js';
import { InlineEditsGutterIndicator } from '../components/gutterIndicatorView.js';
import { LineRange } from '../../../../../../common/core/ranges/lineRange.js';
import { ModelPerInlineEdit } from '../inlineEditsModel.js';
import { HideUnchangedRegionsFeature } from '../../../../../../browser/widget/diffEditor/features/hideUnchangedRegionsFeature.js';
import { Codicon } from '../../../../../../../base/common/codicons.js';
import { renderIcon } from '../../../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { SymbolKinds } from '../../../../../../common/languages.js';
import { debugLogRects, debugView } from './debugVisualization.js';
import { distributeFlexBoxLayout } from './flexBoxLayout.js';
import { Point } from '../../../../../../common/core/2d/point.js';
import { Size2D } from '../../../../../../common/core/2d/size.js';
import { getMaxTowerHeightInAvailableArea } from './layout.js';


const BORDER_WIDTH = 1;
const BORDER_RADIUS = 4;
const ORIGINAL_END_PADDING = 20;
const MODIFIED_END_PADDING = 12;

export class InlineEditsLongDistanceHint extends Disposable implements IInlineEditsView {

	// This is an approximation and should be improved by using the real parameters used bellow
	static fitsInsideViewport(editor: ICodeEditor, textModel: ITextModel, edit: InlineEditWithChanges, reader: IReader): boolean {
		const editorObs = observableCodeEditor(editor);
		const editorWidth = editorObs.layoutInfoWidth.read(reader);
		const editorContentLeft = editorObs.layoutInfoContentLeft.read(reader);
		const editorVerticalScrollbar = editor.getLayoutInfo().verticalScrollbarWidth;
		const minimapWidth = editorObs.layoutInfoMinimap.read(reader).minimapLeft !== 0 ? editorObs.layoutInfoMinimap.read(reader).minimapWidth : 0;

		const maxOriginalContent = maxContentWidthInRange(editorObs, edit.displayRange, undefined/* do not reconsider on each layout info change */);
		const maxModifiedContent = edit.lineEdit.newLines.reduce((max, line) => Math.max(max, getContentRenderWidth(line, editor, textModel)), 0);
		const originalPadding = ORIGINAL_END_PADDING; // padding after last line of original editor
		const modifiedPadding = MODIFIED_END_PADDING + 2 * BORDER_WIDTH; // padding after last line of modified editor

		return maxOriginalContent + maxModifiedContent + originalPadding + modifiedPadding < editorWidth - editorContentLeft - editorVerticalScrollbar - minimapWidth;
	}

	private readonly _editorObs;
	private readonly _onDidClick = this._register(new Emitter<IMouseEvent>());
	readonly onDidClick = this._onDidClick.event;
	private _viewWithElement: ObserverNodeWithElement<HTMLDivElement> | undefined = undefined;
	private readonly _previewRef = n.ref<HTMLDivElement>();
	public readonly previewEditor;

	constructor(
		private readonly _editor: ICodeEditor,
		private readonly _viewState: IObservable<ILongDistanceViewState | undefined>,
		private readonly _previewTextModel: ITextModel,
		private readonly _tabAction: IObservable<InlineEditTabAction>,
		private readonly _model: IObservable<ModelPerInlineEdit | undefined>,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();

		this._editorObs = observableCodeEditor(this._editor);

		this.previewEditor = this._register(this._createPreviewEditor());
		this.previewEditor.setModel(this._previewTextModel);
		this._previewEditorObs = observableCodeEditor(this.previewEditor);
		this._register(this._previewEditorObs.setDecorations(this._editorDecorations));

		this._register(this._instantiationService.createInstance(
			InlineEditsGutterIndicator,
			this._previewEditorObs,
			derived(reader => LineRange.ofLength(this._viewState.read(reader)!.diff[0].modified.startLineNumber, 1)),
			constObservable(0),
			this._model,
			constObservable(false),
			observableValue(this, false),
		));

		this._hintTopLeft = this._editorObs.observePosition(this._hintTextPosition, this._store);

		this._viewWithElement = this._view.keepUpdated(this._store);
		this._register(this._editorObs.createOverlayWidget({
			domNode: this._viewWithElement.element,
			position: constObservable(null),
			allowEditorOverflow: false,
			minContentWidthInPx: constObservable(0),
		}));

		const widgetContent = this._widgetContent.keepUpdated(this._store);

		this._register(autorun(reader => {
			const layoutInfo = this._previewEditorLayoutInfo.read(reader);
			if (!layoutInfo) {
				return;
			}
			const editorRect = layoutInfo.codeEditorRect;
			this.previewEditor.layout({ height: editorRect.height, width: editorRect.width });
		}));

		this._register(autorun(reader => {
			const layoutInfo = this._previewEditorLayoutInfo.read(reader);
			if (!layoutInfo) {
				return;
			}
			this._previewEditorObs.editor.setScrollLeft(layoutInfo.desiredPreviewEditorScrollLeft);
		}));

		this._updatePreviewEditorEffect.recomputeInitiallyAndOnChange(this._store);
	}

	private _createPreviewEditor() {
		return this._instantiationService.createInstance(
			EmbeddedCodeEditorWidget,
			this._previewRef.element,
			{
				glyphMargin: false,
				lineNumbers: 'on',
				minimap: { enabled: false },
				guides: {
					indentation: false,
					bracketPairs: false,
					bracketPairsHorizontal: false,
					highlightActiveIndentation: false,
				},

				rulers: [],
				padding: { top: 0, bottom: 0 },
				//folding: false,
				selectOnLineNumbers: false,
				selectionHighlight: false,
				columnSelection: false,
				overviewRulerBorder: false,
				overviewRulerLanes: 0,
				//lineDecorationsWidth: 0,
				//lineNumbersMinChars: 0,
				revealHorizontalRightPadding: 0,
				bracketPairColorization: { enabled: true, independentColorPoolPerBracketType: false },
				scrollBeyondLastLine: false,
				scrollbar: {
					vertical: 'hidden',
					horizontal: 'hidden',
					handleMouseWheel: false,
				},
				readOnly: true,
				wordWrap: 'off',
				wordWrapOverride1: 'off',
				wordWrapOverride2: 'off',
			},
			{
				contextKeyValues: {
					[InlineCompletionContextKeys.inInlineEditsPreviewEditor.key]: true,
				},
				contributions: [],
			},
			this._editor
		);
	}

	private readonly _editorDecorations = derived(this, reader => {
		const viewState = this._viewState.read(reader);
		if (!viewState) { return []; }

		const hasOneInnerChange = viewState.diff.length === 1 && viewState.diff[0].innerChanges?.length === 1;
		const showEmptyDecorations = true;
		const modifiedDecorations: IModelDeltaDecoration[] = [];

		const diffWholeLineAddDecoration = ModelDecorationOptions.register({
			className: 'inlineCompletions-char-insert',
			description: 'char-insert',
			isWholeLine: true,
		});


		const diffAddDecoration = ModelDecorationOptions.register({
			className: 'inlineCompletions-char-insert',
			description: 'char-insert',
			shouldFillLineOnLineBreak: true,
		});

		const diffAddDecorationEmpty = ModelDecorationOptions.register({
			className: 'inlineCompletions-char-insert diff-range-empty',
			description: 'char-insert diff-range-empty',
		});

		for (const m of viewState.diff) {
			if (m.modified.isEmpty || m.original.isEmpty) {
				if (!m.modified.isEmpty) {
					modifiedDecorations.push({ range: m.modified.toInclusiveRange()!, options: diffWholeLineAddDecoration });
				}
			} else {
				for (const i of m.innerChanges || []) {
					// Don't show empty markers outside the line range
					if (m.modified.contains(i.modifiedRange.startLineNumber)) {
						modifiedDecorations.push({
							range: i.modifiedRange,
							options: (i.modifiedRange.isEmpty() && showEmptyDecorations && hasOneInnerChange)
								? diffAddDecorationEmpty
								: diffAddDecoration
						});
					}
				}
			}
		}

		return modifiedDecorations;
	});


	public get isHovered() { return this._widgetContent.didMouseMoveDuringHover; }

	private readonly _previewEditorObs;

	private readonly _updatePreviewEditorEffect = derived(this, reader => {
		this._widgetContent.readEffect(reader);
		this._previewEditorObs.model.read(reader); // update when the model is set

		const viewState = this._viewState.read(reader);
		if (!viewState) {
			return;
		}
		const range = viewState.edit.originalLineRange;
		const hiddenAreas: Range[] = [];
		if (range.startLineNumber > 1) {
			hiddenAreas.push(new Range(1, 1, range.startLineNumber - 1, 1));
		}
		if (range.startLineNumber + viewState.newTextLineCount < this._previewTextModel.getLineCount() + 1) {
			hiddenAreas.push(new Range(range.startLineNumber + viewState.newTextLineCount, 1, this._previewTextModel.getLineCount() + 1, 1));
		}
		this.previewEditor.setHiddenAreas(hiddenAreas, undefined, true);
	});

	private readonly _hintTextPosition = derived(this, (reader) => {
		const viewState = this._viewState.read(reader);
		return viewState ? new Position(viewState.hint.lineNumber, Number.MAX_SAFE_INTEGER) : null;
	});

	private readonly _lineSizesAroundHintPosition = derived(this, (reader) => {
		const viewState = this._viewState.read(reader);
		const p = this._hintTextPosition.read(reader);
		if (!viewState || !p) {
			return undefined;
		}

		const model = this._editorObs.model.read(reader);
		if (!model) {
			return undefined;
		}
		const range = LineRange.ofLength(p.lineNumber, 1).addMargin(4, 4).intersect(LineRange.ofLength(1, model.getLineCount()));

		if (!range) {
			return undefined;
		}

		const sizes = getContentSizeOfLines(this._editorObs, range, reader);
		const top = this._editorObs.observeTopForLineNumber(range.startLineNumber).read(reader);

		return {
			lineRange: range,
			top: top,
			sizes: sizes,
		};
	});

	private readonly _bottomOfHintLine = derived(this, (reader) => {
		const p = this._hintTextPosition.read(reader);
		if (!p) {
			return constObservable(null);
		}
		return this._editorObs.observeBottomForLineNumber(p.lineNumber);
	}).flatten();

	private readonly _topOfHintLine = derived(this, (reader) => {
		const p = this._hintTextPosition.read(reader);
		if (!p) {
			return constObservable(null);
		}
		return this._editorObs.observeBottomForLineNumber(p.lineNumber);
	}).flatten();

	private readonly _previewEditorLayoutInfo = derived(this, (reader) => {
		const viewState = this._viewState.read(reader);
		if (!viewState) {
			return null;
		}

		const horizontalScrollOffset = this._editorObs.scrollLeft.read(reader);
		const editorLayout = this._editorObs.layoutInfo.read(reader);

		const previewEditorHeight = this._previewEditorObs.observeLineHeightForLine(viewState.edit.modifiedLineRange.startLineNumber).read(reader);

		const h = this._horizontalContentRangeInPreviewEditorToShow.read(reader);

		const previewEditorWidth = h.length;

		const y = this._hintTopLeft.read(reader)?.y;


		const sizes = this._lineSizesAroundHintPosition.read(reader);
		if (!sizes) {
			return undefined;
		}

		const scrollTop = this._editorObs.scrollTop.read(reader);

		// const debugRects = stackSizesDown(new Point(editorLayout.contentLeft, sizes.top - scrollTop), sizes.sizes);

		const contentWidthWithoutScrollbar = editorLayout.contentWidth - editorLayout.verticalScrollbarWidth;
		const editorLayoutContentRight = editorLayout.contentLeft + contentWidthWithoutScrollbar;

		const linePadding = 10;
		const availableSpaceSizes = sizes.sizes.map(s => new Size2D(Math.max(0, contentWidthWithoutScrollbar - s.width - linePadding), s.height));

		if (false) {
			const rects2 = stackSizesDown(new Point(editorLayoutContentRight, sizes.top - scrollTop), availableSpaceSizes, 'right');
			debugView(debugLogRects({ ...rects2 }, this._editor.getDomNode()!), reader);
		}

		const widgetMinSize = new Size2D(200, 3 * 19);
		const heightSums = getSums(availableSpaceSizes, s => s.height);

		const result = findFirstMinimzeDistance(sizes.lineRange.addMargin(-1, -1), viewState.hint.lineNumber, lineNumber => {
			const sizeIdx = lineNumber - sizes.lineRange.startLineNumber;
			const verticalWidgetRange = OffsetRange.ofStartAndLength(heightSums[sizeIdx], widgetMinSize.height);
			const maxWidth = getMaxTowerHeightInAvailableArea(verticalWidgetRange, availableSpaceSizes.map(s => s.transpose()));
			if (maxWidth < widgetMinSize.width) {
				return undefined;
			}
			return { width: maxWidth, verticalWidgetRange };
		});
		if (!result) {
			return undefined;
		}


		const widgetRect2 = Rect.fromRanges(
			OffsetRange.ofStartAndLength(editorLayoutContentRight - result.width, result.width),
			result.verticalWidgetRange.delta(sizes.top - scrollTop)
		).translateX(-horizontalScrollOffset);

		if (false) {
			debugView(debugLogRects({ widgetRect2 }, this._editor.getDomNode()!), reader);
		}


		const rectAvailableSpace = widgetRect2; //Rect.fromRanges(availableHorizontalSpace, new OffsetRange(y - 5, y + 45));


		const layout = distributeFlexBoxLayout(rectAvailableSpace.width, {
			spaceBefore: { min: 20, max: 100, priority: 2 },
			content: [{ min: 150, max: 400, priority: 1 }, { min: 50, max: 150, priority: 2 }],
			spaceAfter: { min: 20 },
		});

		if (!layout) {
			return null;
		}


		const ranges = lengthsToOffsetRanges([layout.spaceBefore, layout.content, layout.spaceAfter], rectAvailableSpace.left);
		const spaceBeforeRect = rectAvailableSpace.withHorizontalRange(ranges[0]);
		const contentRect = rectAvailableSpace.withHorizontalRange(ranges[1]);
		const spaceAfterRect = rectAvailableSpace.withHorizontalRange(ranges[2]);

		// [ buffer, min: 0, max: 100, cur: 100, maximize 2!  ] [ content, min: 300, max: 500, maximize 1! ] [ space, min: 0 ]
		//

		//editorLayout.contentWidth

		const marginToCursor = 100;
		const editorPaddingX = 2;
		const borderWidth = 2;
		const codeEditorRect = contentRect.withHeight(previewEditorHeight + 2);
		/*Rect.fromLeftTopWidthHeight(hintTopLeft.x + editorLayout.contentLeft + marginToCursor, y, previewEditorWidth, previewEditorHeight)
			.withMargin(0, 0, 2, 0).translateX(borderWidth + editorPaddingX);
			*/

		const lowerBarHeight = 20;
		const codeEditorRectWithPadding = codeEditorRect.withMargin(borderWidth);
		const widgetRect = codeEditorRectWithPadding.withMargin(editorPaddingX, editorPaddingX, lowerBarHeight, editorPaddingX);

		if (false) {
			debugView(debugLogRects({ spaceBeforeRect, contentRect, spaceAfterRect }, this._editor.getDomNode()!), reader);
		}

		return {
			codeEditorRect,
			codeScrollLeft: horizontalScrollOffset,
			contentLeft: editorLayout.contentLeft,

			widgetRect,
			codeEditorRectWithPadding,

			editorPaddingX,
			borderWidth,
			lowerBarHeight,

			desiredPreviewEditorScrollLeft: h.start,
			previewEditorWidth,
		};
	});

	private readonly _hintTopLeft;

	private readonly _horizontalContentRangeInPreviewEditorToShow = derived(this, reader => {
		return this._getHorizontalContentRangeInPreviewEditorToShow(this.previewEditor, this._viewState.read(reader)?.diff ?? []);
	});

	private _getHorizontalContentRangeInPreviewEditorToShow(editor: ICodeEditor, diff: DetailedLineRangeMapping[]): OffsetRange {
		return new OffsetRange(55, 400);
		return new OffsetRange(0, editor.getContentWidth());
	}

	private readonly _view = n.div({
		class: 'inline-edits-view',
		style: {
			position: 'absolute',
			overflow: 'visible',
			top: '0px',
			left: '0px',
			display: derived(this, reader => !!this._previewEditorLayoutInfo.read(reader) ? 'block' : 'none'),
		},
	}, [
		derived(this, _reader => [this._widgetContent]),
	]);

	private readonly _originalOutlineSource = derivedDisposable(this, (reader) => {
		const m = this._editorObs.model.read(reader);
		const factory = HideUnchangedRegionsFeature._breadcrumbsSourceFactory.read(reader);
		return (!m || !factory) ? undefined : factory(m, this._instantiationService);
	});

	private readonly _widgetContent = n.div({
		style: {
			position: 'absolute',
			overflow: 'hidden',
			cursor: 'pointer',
			background: '#313131',
			padding: this._previewEditorLayoutInfo.map(i => i?.borderWidth),
			borderRadius: BORDER_RADIUS,
			display: 'flex',
			flexDirection: 'column',
			...rectToProps(reader => this._previewEditorLayoutInfo.read(reader)?.widgetRect)
		},
		onmousedown: e => {
			e.preventDefault(); // This prevents that the editor loses focus
		},
		onclick: (e) => {
			this._onDidClick.fire(new StandardMouseEvent(getWindow(e), e));
		}
	}, [
		n.div({
			class: ['editorContainer'],
			style: { overflow: 'hidden', padding: this._previewEditorLayoutInfo.map(i => i?.editorPaddingX), background: '#1f1f1f' },
		}, [
			n.div({ class: 'preview', style: { /*pointerEvents: 'none'*/ }, ref: this._previewRef }),
		]),
		n.div({ class: 'bar', style: { pointerEvents: 'none', margin: '0 4px', height: this._previewEditorLayoutInfo.map(i => i?.lowerBarHeight), display: 'flex', justifyContent: 'flex-start', alignItems: 'center' } }, [
			derived(this, reader => {
				const children: (HTMLElement | ObserverNode<HTMLDivElement>)[] = [];
				const s = this._viewState.read(reader);
				const source = this._originalOutlineSource.read(reader);
				if (!s || !source) {
					return [];
				}
				const items = source.getAt(s.edit.lineEdit.lineRange.startLineNumber, reader).slice(0, 1);

				if (items.length > 0) {
					for (let i = 0; i < items.length; i++) {
						const item = items[i];
						const icon = SymbolKinds.toIcon(item.kind);
						children.push(n.div({
							class: 'breadcrumb-item',
							style: { display: 'flex', alignItems: 'center' },
						}, [
							renderIcon(icon),
							'\u00a0',
							item.name,
							...(i === items.length - 1
								? []
								: [renderIcon(Codicon.chevronRight)]
							)
						]));
						/*divItem.onclick = () => {
						};*/
					}
				}
				return children;
			})
		]),
	]);
}

export interface ILongDistanceHint {
	lineNumber: number;
}

export interface ILongDistanceViewState {
	hint: ILongDistanceHint;
	newTextLineCount: number;
	edit: InlineEditWithChanges;
	diff: DetailedLineRangeMapping[];
}

function lengthsToOffsetRanges(lengths: number[], initialOffset = 0): OffsetRange[] {
	const result: OffsetRange[] = [];
	let offset = initialOffset;
	for (const length of lengths) {
		result.push(new OffsetRange(offset, offset + length));
		offset += length;
	}
	return result;
}


function stackSizesDown(at: Point, sizes: Size2D[], alignment: 'left' | 'right' = 'left'): Rect[] {
	const rects: Rect[] = [];
	let offset = 0;
	for (const s of sizes) {
		rects.push(
			Rect.fromLeftTopWidthHeight(
				at.x + (alignment === 'left' ? 0 : -s.width),
				at.y + offset,
				s.width,
				s.height
			)
		);
		offset += s.height;
	}
	return rects;
}

function findFirstMinimzeDistance<T>(range: LineRange, targetLine: number, predicate: (lineNumber: number) => T | undefined): T | undefined {
	for (let offset = 0; ; offset++) {
		const down = targetLine + offset;
		if (down <= range.endLineNumberExclusive) {
			const result = predicate(down);
			if (result !== undefined) {
				return result;
			}
		}
		const up = targetLine - offset;
		if (up >= range.startLineNumber) {
			const result = predicate(up);
			if (result !== undefined) {
				return result;
			}
		}
		if (up < range.startLineNumber && down > range.endLineNumberExclusive) {
			return undefined;
		}
	}
}

function getSums<T>(array: T[], fn: (item: T) => number): number[] {
	const result: number[] = [0];
	let sum = 0;
	for (const item of array) {
		sum += fn(item);
		result.push(sum);
	}
	return result;
}
