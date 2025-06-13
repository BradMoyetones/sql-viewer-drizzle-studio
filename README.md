# SQL Viewer with Drizzle Studio

This is a small Node.js project using Express and Drizzle Studio to provide a basic interface for listing and exploring the databases available on a SQL server (Postgres, mysql, etc).

## Features

- Lists all databases available on the connected MySQL server  
- Allows selecting a database to launch Drizzle Studio  
- Automatically sets the DATABASE_URL when a database is selected  
- Lightweight and easy to set up  

## Requirements

- Node.js (v20 or higher recommended)
- Access to a SQL server
- npx (included with Node.js)

## Getting Started

1. Clone the repository:

```bash
git clone https://github.com/BradMoyetones/sql-viewer-drizzle-studio.git
cd sql-viewer-drizzle-studio
```

2. Install dependencies:

```bash
npm install
```

3. Rename the example environment file:

```bash
mv .env.example .env
```

4. Edit the .env file and fill in the following variables:

```bash
DB_HOST=your-sql-host
DB_USER=your-sql-username
DB_PASSWORD=your-sql-password
DB_PORT=3306
```

   ⚠️ Do NOT set DATABASE_URL manually.  
   It will be automatically set when you select a database from the interface.

5. Run the development server:
```bash
npm run dev
````

6. Open your browser at:  

`http://localhost:3000`

## Notes

- This tool is meant for local development and database inspection  
- Make sure your SQL server accepts connections from your machine  
