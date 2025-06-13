import 'dotenv/config'; // Carga las variables de entorno desde .env
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
    schema: './schema/*',
    out: './drizzle',
    dialect: 'mysql',
    dbCredentials: {
        url: process.env.DATABASE_URL!,
    },
});
