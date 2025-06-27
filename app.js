const express = require('express');
const mysql = require('mysql2/promise');
const { spawn, execSync, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const util = require('util');
const archiver = require('archiver');
require('dotenv').config();

const execPromise = util.promisify(exec);

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

let currentProgress = {
    status: 'idle',
    percent: 0,
    message: '',
};

// Endpoint SSE para ver el progreso en tiempo real
app.get('/backup/status', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const interval = setInterval(() => {
        res.write(`data: ${JSON.stringify(currentProgress)}\n\n`);
        if (currentProgress.status === 'done' || currentProgress.status === 'error') {
            clearInterval(interval);
            res.end();
        }
    }, 500);
});

// Endpoint principal que genera el backup de todas las bases de datos
app.get('/backup/all', async (req, res) => {
    try {
        currentProgress = { status: 'in_progress', percent: 0, message: 'Inicializando conexión...' };

        const conn = await mysql.createConnection({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
        });

        const [databases] = await conn.query('SHOW DATABASES');
        const skip = ['information_schema', 'performance_schema', 'mysql', 'sys'];
        const filteredDbs = databases.map(db => db.Database).filter(name => !skip.includes(name));

        const total = filteredDbs.length;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const zipPath = path.join(os.tmpdir(), `full_backup_${timestamp}.zip`);
        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        // Cuando finaliza el ZIP
        output.on('close', () => {
            currentProgress = { status: 'done', percent: 100, message: '✅ Backup completo' };
            res.download(zipPath, () => fs.unlinkSync(zipPath));
        });

        // Si hay error al comprimir
        archive.on('error', (err) => {
            currentProgress = { status: 'error', percent: 0, message: `Error en zip: ${err.message}` };
            res.status(500).send('Error al comprimir los backups.');
        });

        archive.pipe(output);

        // Archivo temporal de credenciales para mysqldump
        const credsFile = path.join(__dirname, 'tmp.cnf');
        fs.writeFileSync(credsFile, `\n[client]\nuser=${process.env.DB_USER}\npassword=${process.env.DB_PASSWORD}\nhost=${process.env.DB_HOST}\n`.trim());

        for (let i = 0; i < total; i++) {
            const dbName = filteredDbs[i];
            const tmpFile = path.join(os.tmpdir(), `${dbName}_${timestamp}.sql`);

            currentProgress = {
                status: 'in_progress',
                percent: Math.round((i / total) * 100),
                message: `Respaldando ${dbName}... (${i + 1}/${total})`,
            };

            await new Promise((resolve, reject) => {
                const dumpProcess = spawn('mysqldump', [
                    `--defaults-extra-file=${credsFile}`,
                    dbName
                ]);

                const outputStream = fs.createWriteStream(tmpFile);
                dumpProcess.stdout.pipe(outputStream);

                let stderr = '';
                dumpProcess.stderr.on('data', data => {
                    stderr += data.toString();
                });

                dumpProcess.on('close', code => {
                    if (code === 0) {
                        archive.file(tmpFile, { name: `${dbName}.sql` });
                        resolve();
                    } else {
                        reject(new Error(`mysqldump falló en ${dbName} con código ${code}: ${stderr}`));
                    }
                });
            });
        }

        archive.finalize();
        fs.unlinkSync(credsFile);
    } catch (err) {
        currentProgress = { status: 'error', percent: 0, message: `Error general: ${err.message}` };
        res.status(500).send('Error al hacer backups.');
    }
});

app.listen(PORT, () => {
    console.log(`✅ Servidor escuchando en http://localhost:${PORT}`);
});
