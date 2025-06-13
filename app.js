const express = require('express');
const mysql = require('mysql2/promise');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

let drizzleProcess = null;

function killDrizzleProcess() {
    if (drizzleProcess) {
        drizzleProcess.kill('SIGKILL');
        console.log(`🔪 Drizzle Studio matado (PID ${drizzleProcess.pid})`);
        drizzleProcess = null;
    }

    try {
        const result = execSync(`pgrep -f drizzle-kit`).toString().trim().split('\n');
        result.forEach(pid => {
            execSync(`kill -9 ${pid}`);
            console.log(`🔪 Matado proceso huérfano drizzle-kit (PID ${pid})`);
        });
    } catch {
        console.log(`ℹ️ No hay procesos drizzle-kit huérfanos.`);
    }
}

app.get('/', async (req, res) => {
    try {
        const conn = await mysql.createConnection({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            multipleStatements: true,
        });

        const [databases] = await conn.query('SHOW DATABASES');

        const dbWithTables = [];

        for (const db of databases) {
            const dbName = db.Database;

            try {
                const [tables] = await conn.query(`SHOW TABLES FROM \`${dbName}\``);
                const tableKey = `Tables_in_${dbName}`;
                dbWithTables.push({
                    name: dbName,
                    tables: tables.map(t => t[tableKey]),
                });
            } catch (err) {
                console.warn(`⚠️ No se pudieron obtener tablas de ${dbName}:`, err.message);
                dbWithTables.push({
                    name: dbName,
                    tables: [],
                });
            }
        }

        res.render('index', {
            databases: dbWithTables, // ✅ estructura de array con name y tables
            selectedDb: null,
            message: null,
        });

    } catch (err) {
        console.error('❌ Error al conectar a MySQL:', err.message);
        res.render('index', {
            databases: [],
            selectedDb: null,
            message: 'No se pudo conectar con el servidor de base de datos.',
        });
    }
});

app.post('/select', (req, res) => {
    const db = req.body.database;
    if (!db) return res.status(400).json({ error: 'No se especificó una base de datos.' });

    const dbUrl = `mysql://${encodeURIComponent(process.env.DB_USER)}:${encodeURIComponent(process.env.DB_PASSWORD)}@${process.env.DB_HOST}:${process.env.DB_PORT}/${encodeURIComponent(db)}`;

    try {
        new URL(dbUrl);
    } catch {
        console.error("❌ URL inválida:", dbUrl);
        return res.status(400).send({ error: 'URL inválida para Drizzle Studio' });
    }

    killDrizzleProcess();

    console.log(`🚀 Iniciando Drizzle Studio para ${db}...`);

    drizzleProcess = spawn('npx', ['drizzle-kit', 'studio', '--port=3001'], {
        stdio: 'inherit',
        shell: true,
        env: {
            ...process.env,
            DATABASE_URL: dbUrl,
        },
    });

    drizzleProcess.on('exit', (code, signal) => {
        console.log(`💀 Drizzle Studio terminó - código ${code}, señal ${signal}`);
        drizzleProcess = null;
    });

    res.status(200).json({ message: `Drizzle Studio lanzado para ${db}` });
});

app.get('/backup/json', async (req, res) => {
    const db = req.query.db;
    if (!db) {
        return res.status(400).send('Falta el parámetro ?db=nombre_base');
    }

    try {
        const conn = await mysql.createConnection({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: db,
        });

        const [tables] = await conn.query('SHOW TABLES');
        const data = {};

        for (let row of tables) {
            const tableName = Object.values(row)[0];
            const [rows] = await conn.query(`SELECT * FROM \`${tableName}\``);
            data[tableName] = rows;
        }

        const filePath = path.join(__dirname, `backup_${db}.json`);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        console.log(`📦 Backup creado: ${filePath}`);

        res.download(filePath, (err) => {
            if (err) console.error('❌ Error al descargar:', err.message);
            fs.unlinkSync(filePath); // Elimina el archivo después de enviarlo
        });

    } catch (err) {
        console.error('❌ Error al hacer backup:', err.message);
        res.status(500).send('Error al hacer el backup.');
    }
});

app.get('/backup/sql', async (req, res) => {
    const db = req.query.db;
    if (!db) {
        return res.status(400).send('Falta el parámetro ?db=nombre_base');
    }

    const credsFile = path.join(__dirname, 'tmp.cnf');
    const filePath = path.join(__dirname, `backup_${db}.sql`);
    const cnfContent = `
[client]
user=${process.env.DB_USER}
password=${process.env.DB_PASSWORD}
host=${process.env.DB_HOST}
`;

    fs.writeFileSync(credsFile, cnfContent.trim());

    const dumpCmd = `mysqldump --defaults-extra-file=${credsFile} ${db} > ${filePath}`;

    exec(dumpCmd, (err) => {
        fs.unlinkSync(credsFile); // elimina credenciales sensibles

        if (err) {
            console.error('❌ Error al generar el backup SQL:', err.message);
            return res.status(500).send('Error al generar el backup.');
        }

        console.log(`📦 Backup SQL creado: ${filePath}`);
        res.download(filePath, (err) => {
            if (err) console.error('❌ Error al descargar:', err.message);
            fs.unlinkSync(filePath);
        });
    });
});

app.listen(PORT, () => {
    console.log(`✅ Servidor escuchando en http://localhost:${PORT}`);
});
