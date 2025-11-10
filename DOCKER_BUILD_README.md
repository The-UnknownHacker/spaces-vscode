# Building Custom VS Code with code-server

This guide helps you build and deploy your custom VS Code (with custom branding and logo) using code-server through Docker.

## Prerequisites

- Docker installed and running
- Docker Compose (or Docker with compose plugin)
- At least 8GB of RAM available for Docker
- 10-20 minutes for the initial build

## Quick Start

### Option 1: Using the build script (Recommended)

```bash
./build-and-run.sh
```

This script will:
1. Build your custom VS Code Docker image
2. Ask if you want to start the container
3. Provide access information

### Option 2: Manual build with docker-compose

```bash
# Build the image
docker-compose build

# Start the container
docker-compose up -d

# View logs
docker-compose logs -f
```

### Option 3: Manual build with Docker

```bash
# Build the image
docker build -f Dockerfile.code-server -t custom-vscode-server .

# Run the container
docker run -d \
  --name custom-vscode-server \
  -p 8080:8080 \
  -v "$(pwd)/workspace:/home/coder/workspace" \
  -e PASSWORD=changeme \
  custom-vscode-server
```

## Accessing Your Custom VS Code

Once the container is running, open your browser and navigate to:

```
http://localhost:8080
```

Default password: `changeme`

## Configuration

### Change Password

Edit the `docker-compose.yml` file or set environment variable:

```bash
export CODE_SERVER_PASSWORD=your-secure-password
docker-compose up -d
```

### Change Port

Edit `docker-compose.yml` and change the port mapping:

```yaml
ports:
  - "3000:8080"  # Access on port 3000 instead
```

### Persist Your Work

Your workspace is automatically mounted to `./workspace` directory. Any files you create in code-server will be saved there.

## Useful Commands

```bash
# View logs
docker-compose logs -f

# Stop the server
docker-compose down

# Restart the server
docker-compose restart

# Rebuild after code changes
docker-compose build --no-cache
docker-compose up -d

# Access container shell
docker-compose exec custom-code-server bash
```

## Troubleshooting

### Build fails with memory errors

Increase Docker memory limit to at least 8GB in Docker Desktop settings.

### Port 8080 already in use

Change the port in `docker-compose.yml`:

```yaml
ports:
  - "8081:8080"
```

### Custom branding not showing

Make sure your changes to `product.json` and logo files are committed before building.

### Build takes too long

The first build will take 10-20 minutes as it compiles VS Code from source. Subsequent builds will be faster due to Docker layer caching.

## Architecture

This setup uses a multi-stage Docker build:

1. **Stage 1 (vscode-builder)**: Compiles your custom VS Code
   - Installs dependencies
   - Builds the web version (vscode-reh-web)
   - Compiles extensions

2. **Stage 2 (code-server)**: Creates the final image
   - Uses official code-server base image
   - Replaces default VS Code with your custom build
   - Configures proper permissions and entrypoint

## Customization

Your custom branding from `product.json` will be included:
- Custom name: "Spaces"
- Custom application name
- Custom logos and icons

All your modifications to the VS Code source code will be included in the build.

## Production Deployment

For production use, consider:

1. Using a reverse proxy (nginx, Caddy) with HTTPS
2. Setting a strong password or using authentication
3. Configuring proper backup for the workspace volume
4. Using Docker secrets for sensitive data
5. Setting resource limits in docker-compose.yml

Example with resource limits:

```yaml
services:
  custom-code-server:
    # ... other config ...
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 4G
        reservations:
          cpus: '1'
          memory: 2G
```

## Next Steps

- Customize your VS Code further in the source code
- Add custom extensions to the build
- Configure code-server settings in `/home/coder/.config/code-server/config.yaml`
- Set up automated builds with CI/CD

## Support

If you encounter issues:
1. Check Docker logs: `docker-compose logs -f`
2. Verify your custom VS Code builds locally: `npm run compile-web`
3. Ensure all dependencies are installed
4. Check Docker has enough resources allocated
