# Docker Compose Guide for Integration Control Plane

This guide explains how to use the Docker Compose files to build and run the Integration Control Plane (ICP) with different database backends.

## Available Configurations

Four Docker Compose files are provided for testing ICP with different databases:

1. **docker-compose-h2.yml** - H2 embedded database (no external database required)
2. **docker-compose-mysql.yml** - MySQL database
3. **docker-compose-mssql.yml** - Microsoft SQL Server database
4. **docker-compose-postgresql.yml** - PostgreSQL database

## Prerequisites

- Docker Engine 20.10+
- Docker Compose V2
- At least 4GB of available RAM
- Port availability:
  - 9445 (ICP HTTPS)
  - 9446 (ICP GraphQL)
  - 9449 (ICP Observability)
  - Database ports: 3306 (MySQL), 1433 (MSSQL), 5432 (PostgreSQL)

## How It Works

Each Docker Compose file:
1. Builds the ICP using `./gradlew clean build` (via the Dockerfile)
2. Unpacks the `wso2-integration-control-plane-2.0.0-SNAPSHOT.zip`
3. Starts the appropriate database service (except for H2)
4. Configures ICP to connect to the database
5. Starts the ICP server

## Usage

### H2 Database (Embedded)

H2 is the default embedded database. No external database service is required.

```bash
# Start ICP with H2
docker compose -f docker-compose-h2.yml up --build

# Start in detached mode
docker compose -f docker-compose-h2.yml up --build -d

# View logs
docker compose -f docker-compose-h2.yml logs -f

# Stop
docker compose -f docker-compose-h2.yml down
```

H2 data is persisted in `./data/h2/` directory.

### MySQL Database

```bash
# Start ICP with MySQL
docker compose -f docker-compose-mysql.yml up --build

# Start in detached mode
docker compose -f docker-compose-mysql.yml up --build -d

# View logs
docker compose -f docker-compose-mysql.yml logs -f icp-server

# View database logs
docker compose -f docker-compose-mysql.yml logs -f mysql-db

# Stop
docker compose -f docker-compose-mysql.yml down

# Stop and remove volumes (delete database data)
docker compose -f docker-compose-mysql.yml down -v
```

**Database credentials:**
- Host: `mysql-db` (from ICP container) or `localhost` (from host)
- Port: `3306`
- Database: `icp_database`
- User: `root`
- Password: `my-secret-pw`

### Microsoft SQL Server

```bash
# Start ICP with MSSQL
docker compose -f docker-compose-mssql.yml up --build

# Start in detached mode
docker compose -f docker-compose-mssql.yml up --build -d

# View logs
docker compose -f docker-compose-mssql.yml logs -f icp-server

# View database logs
docker compose -f docker-compose-mssql.yml logs -f mssql-db

# Stop
docker compose -f docker-compose-mssql.yml down

# Stop and remove volumes (delete database data)
docker compose -f docker-compose-mssql.yml down -v
```

**Database credentials:**
- Host: `mssql-db` (from ICP container) or `localhost` (from host)
- Port: `1433`
- Database: `icp_database`
- User: `sa`
- Password: `YourStrong@Passw0rd`

### PostgreSQL Database

```bash
# Start ICP with PostgreSQL
docker compose -f docker-compose-postgresql.yml up --build

# Start in detached mode
docker compose -f docker-compose-postgresql.yml up --build -d

# View logs
docker compose -f docker-compose-postgresql.yml logs -f icp-server

# View database logs
docker compose -f docker-compose-postgresql.yml logs -f postgresql-db

# Stop
docker compose -f docker-compose-postgresql.yml down

# Stop and remove volumes (delete database data)
docker compose -f docker-compose-postgresql.yml down -v
```

**Database credentials:**
- Host: `postgresql-db` (from ICP container) or `localhost` (from host)
- Port: `5432`
- Database: `icp_database`
- User: `postgres`
- Password: `my-secret-pw`

## Accessing ICP

Once started, ICP will be available at:
- **HTTPS API**: https://localhost:9445
- **GraphQL**: https://localhost:9446
- **Observability**: http://localhost:9449

Note: The HTTPS endpoint uses a self-signed certificate. You may need to accept the certificate warning in your browser.

## Configuration

Database-specific configurations are stored in the `config/` directory:
- `config/mysql-config.toml`
- `config/mssql-config.toml`
- `config/postgresql-config.toml`

You can modify these files to customize database connection settings, credentials, and other ICP configurations.

## Logs

Application logs are stored in the `./logs/` directory and are accessible from the host machine.

## Data Persistence

- **H2**: Data is persisted in `./data/h2/` directory
- **MySQL**: Data is persisted in Docker volume `mysql-data`
- **MSSQL**: Data is persisted in Docker volume `mssql-data`
- **PostgreSQL**: Data is persisted in Docker volume `postgresql-data`

To remove all data, use the `-v` flag when stopping:
```bash
docker compose -f docker-compose-<database>.yml down -v
```

## Troubleshooting

### Build fails

If the build fails, try cleaning up Docker resources:
```bash
# Remove all stopped containers
docker container prune

# Remove all unused images
docker image prune -a

# Remove all unused volumes
docker volume prune
```

### Database connection errors

1. Check if the database container is healthy:
   ```bash
   docker compose -f docker-compose-<database>.yml ps
   ```

2. Check database logs:
   ```bash
   docker compose -f docker-compose-<database>.yml logs <database>-db
   ```

3. Verify database is accepting connections:
   ```bash
   # MySQL
   docker exec -it icp-mysql-db mysql -u root -p

   # PostgreSQL
   docker exec -it icp-postgresql-db psql -U postgres -d icp_database

   # MSSQL
   docker exec -it icp-mssql-db /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -C
   ```

### Port conflicts

If you get port binding errors, check if the ports are already in use:
```bash
# Check port usage (macOS/Linux)
lsof -i :9445
lsof -i :9446
lsof -i :3306
lsof -i :5432
lsof -i :1433
```

## Rebuilding

To rebuild ICP after code changes:

```bash
# Rebuild without cache
docker compose -f docker-compose-<database>.yml build --no-cache

# Rebuild and restart
docker compose -f docker-compose-<database>.yml up --build --force-recreate
```

## Development Workflow

For development, you can use this workflow:

1. Make code changes
2. Rebuild and restart:
   ```bash
   docker compose -f docker-compose-h2.yml up --build
   ```
3. Test your changes
4. Stop and clean up:
   ```bash
   docker compose -f docker-compose-h2.yml down
   ```

## Security Note

The default passwords in these Docker Compose files are for **testing purposes only**.

**DO NOT use these configurations in production without changing:**
- Database passwords
- JWT secrets
- TLS certificates

For production deployments, use strong passwords and consider using Docker secrets or environment variables from a secure vault.
