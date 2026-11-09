import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Chargement automatique du fichier .env s'il existe à la racine du projet
const envFilePath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFilePath)) {
  const envContent = fs.readFileSync(envFilePath, 'utf8');
  for (const line of envContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

export function hashPassword(password) {
  return crypto.createHash('sha256').update(String(password)).digest('hex');
}

export function formatMatricule(num) {
  return `INT_${String(num).padStart(6, '0')}`;
}

export function formatEvacuationMatricule(num) {
  return `EVAC_${String(num).padStart(6, '0')}`;
}

export function formatEvacuationSpecialeMatricule(num) {
  return `SPEC_${String(num).padStart(6, '0')}`;
}

let pgPool = null;
let sqliteDb = null;
let activeEngine = 'postgres'; // 'postgres' or 'sqlite'

function normalizeDatabaseUrl(rawUrl) {
  if (!rawUrl) return '';
  let cleaned = String(rawUrl).trim();
  // Corriger un éventuel doublon "postgresql://postgresql://"
  cleaned = cleaned.replace(/^(postgres(?:ql)?:\/\/)+/i, 'postgresql://');

  // Encoder automatiquement les caractères spéciaux (@, #) dans le mot de passe s'il n'est pas déjà encodé
  const match = cleaned.match(/^(postgresql:\/\/)([^:]+):(.+)@([^@]+)$/i);
  if (match) {
    const [, scheme, user, rawPass, hostAndDb] = match;
    // Si rawPass contient '#' ou '@' non encodé
    const safePass = rawPass
      .replace(/#/g, '%23')
      .replace(/@/g, '%40');
    cleaned = `${scheme}${user}:${safePass}@${hostAndDb}`;
  }
  return cleaned;
}

const DATABASE_URL = normalizeDatabaseUrl(process.env.DATABASE_URL || process.env.POSTGRES_URL || '');

const PG_CONFIG = DATABASE_URL
  ? {
      connectionString: DATABASE_URL,
      ssl:
        DATABASE_URL.includes('localhost') || DATABASE_URL.includes('127.0.0.1')
          ? false
          : { rejectUnauthorized: false },
    }
  : {
      host: process.env.PGHOST || process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.PGPORT || process.env.DB_PORT || 5432),
      user: process.env.PGUSER || process.env.DB_USER || 'postgres',
      password: process.env.PGPASSWORD || process.env.DB_PASSWORD || 'postgres',
      database: process.env.PGDATABASE || process.env.DB_NAME || 'Ges_evac_db',
      ssl:
        process.env.PGSSLMODE === 'require' || process.env.DB_SSL === 'true'
          ? { rejectUnauthorized: false }
          : false,
    };

export function getDbStatus() {
  if (activeEngine === 'postgres') {
    let hostLabel = `${PG_CONFIG.host || 'cloud'}:${PG_CONFIG.port || 5432}`;
    if (DATABASE_URL) {
      try {
        const u = new URL(DATABASE_URL);
        hostLabel = `${u.hostname}:${u.port || 5432}`;
      } catch {
        hostLabel = 'Cloud PostgreSQL (DATABASE_URL)';
      }
    }
    return {
      engine: 'postgresql',
      database: PG_CONFIG.database || 'PostgreSQL Cloud',
      host: hostLabel,
    };
  }
  return {
    engine: 'sqlite',
    database: 'Ges_evac_db',
    host: 'local (Ges_evac_db.sqlite)',
  };
}

// Convertit les marqueurs '?' en '$1, $2, ...' pour PostgreSQL
function convertSqlToPostgres(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => {
    index += 1;
    return `$${index}`;
  });
}

export async function initDatabase() {
  try {
    const pgModule = await import('pg');
    const Pool = pgModule.default?.Pool || pgModule.Pool;

    // Si on est en local sans DATABASE_URL, tenter de créer la base Ges_evac_db si elle n'existe pas
    if (!DATABASE_URL && (PG_CONFIG.host === '127.0.0.1' || PG_CONFIG.host === 'localhost')) {
      try {
        const adminPool = new Pool({
          ...PG_CONFIG,
          database: 'postgres',
        });
        const checkDb = await adminPool.query(
          'SELECT 1 FROM pg_database WHERE datname = $1',
          [PG_CONFIG.database]
        );
        if (checkDb.rowCount === 0) {
          await adminPool.query(`CREATE DATABASE "${PG_CONFIG.database}"`);
        }
        await adminPool.end();
      } catch {
        // Ignorer si la base existe déjà ou si l'utilisateur se connecte directement à la base cible
      }
    }

    pgPool = new Pool(PG_CONFIG);
    // Vérifier la connexion PostgreSQL
    await pgPool.query('SELECT 1');

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        prenoms VARCHAR(100) NOT NULL,
        nom VARCHAR(100) NOT NULL,
        telephone VARCHAR(30) NOT NULL,
        login VARCHAR(60) NOT NULL UNIQUE,
        mot_de_passe VARCHAR(255) NOT NULL,
        role VARCHAR(30) NOT NULL DEFAULT 'teleoperateur',
        statut VARCHAR(30) NOT NULL DEFAULT 'approuve',
        reset_mot_de_passe VARCHAR(255) DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pgPool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(30) NOT NULL DEFAULT 'teleoperateur'`);
    await pgPool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS statut VARCHAR(30) NOT NULL DEFAULT 'approuve'`);
    await pgPool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_mot_de_passe VARCHAR(255) DEFAULT NULL`);

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS medecins (
        id SERIAL PRIMARY KEY,
        prenoms VARCHAR(100) NOT NULL,
        nom VARCHAR(100) NOT NULL,
        contact VARCHAR(30) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS services (
        id SERIAL PRIMARY KEY,
        nom_service VARCHAR(120) NOT NULL UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS equipes_secours (
        id SERIAL PRIMARY KEY,
        libelle VARCHAR(100) NOT NULL UNIQUE,
        chef_equipe VARCHAR(150) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS lieux_prise_en_charge (
        id SERIAL PRIMARY KEY,
        nom_lieu VARCHAR(190) NOT NULL UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS interventions (
        id SERIAL PRIMARY KEY,
        matricule VARCHAR(50) NOT NULL,
        type_patient VARCHAR(40) NOT NULL DEFAULT 'Etudiant',
        num_carte_etudiant VARCHAR(60) NOT NULL,
        prenoms VARCHAR(100) NOT NULL,
        nom VARCHAR(100) NOT NULL,
        date_naissance VARCHAR(30) NULL,
        lieu_naissance VARCHAR(120) NULL,
        contact VARCHAR(30) NULL,
        service_agent_adresse VARCHAR(190) NULL,
        lieu_prise_en_charge VARCHAR(190) NULL,
        destination VARCHAR(190) NULL,
        plaintes TEXT NOT NULL,
        date_heure_intervention VARCHAR(50) NOT NULL,
        agent_en_charge VARCHAR(150) NOT NULL,
        user_id INT NULL,
        user_nom VARCHAR(150) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS evacuations (
        id SERIAL PRIMARY KEY,
        matricule VARCHAR(50) NOT NULL DEFAULT '',
        type_patient VARCHAR(40) NOT NULL DEFAULT 'Etudiant',
        num_carte_etudiant VARCHAR(60) NOT NULL,
        prenoms VARCHAR(100) NOT NULL,
        nom VARCHAR(100) NOT NULL,
        contact VARCHAR(30) NULL,
        service_agent_adresse VARCHAR(190) NULL,
        motif TEXT NOT NULL,
        service VARCHAR(120) NOT NULL DEFAULT 'Urgence',
        medecin VARCHAR(150) NOT NULL,
        structure_evacuation VARCHAR(150) NOT NULL,
        date_heure VARCHAR(50) NOT NULL,
        statut_evacuation VARCHAR(30) NOT NULL DEFAULT 'Ouverte',
        date_heure_fermeture VARCHAR(50) NULL,
        infos_en_cours TEXT NULL,
        issue_evacuation VARCHAR(120) NULL,
        user_id INT NULL,
        user_nom VARCHAR(150) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS evacuations_speciales (
        id SERIAL PRIMARY KEY,
        matricule VARCHAR(50) NOT NULL DEFAULT '',
        type_patient VARCHAR(40) NOT NULL DEFAULT 'Etudiant',
        num_carte VARCHAR(60) NOT NULL,
        prenoms VARCHAR(100) NOT NULL,
        nom VARCHAR(100) NOT NULL,
        contact VARCHAR(30) NULL,
        service_agent_adresse VARCHAR(190) NULL,
        service VARCHAR(120) NOT NULL DEFAULT 'Urgence',
        motifs TEXT NOT NULL,
        regulation VARCHAR(10) NOT NULL DEFAULT 'Non',
        accompagnement_medical VARCHAR(150) NULL,
        medecin VARCHAR(150) NOT NULL,
        structure VARCHAR(150) NOT NULL,
        date_heure VARCHAR(50) NOT NULL,
        statut_evacuation VARCHAR(30) NOT NULL DEFAULT 'Ouverte',
        date_heure_fermeture VARCHAR(50) NULL,
        infos_en_cours TEXT NULL,
        issue_evacuation VARCHAR(120) NULL,
        user_id INT NULL,
        user_nom VARCHAR(150) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pgPool.query(`ALTER TABLE interventions ADD COLUMN IF NOT EXISTS lieu_prise_en_charge VARCHAR(190) NULL`);
    await pgPool.query(`ALTER TABLE interventions ADD COLUMN IF NOT EXISTS destination VARCHAR(190) NULL`);
    await pgPool.query(`ALTER TABLE evacuations_speciales ADD COLUMN IF NOT EXISTS service VARCHAR(120) NOT NULL DEFAULT 'Urgence'`);

    for (const tbl of ['evacuations', 'evacuations_speciales']) {
      await pgPool.query(`ALTER TABLE ${tbl} ADD COLUMN IF NOT EXISTS matricule VARCHAR(50) NOT NULL DEFAULT ''`);
      await pgPool.query(`ALTER TABLE ${tbl} ADD COLUMN IF NOT EXISTS statut_evacuation VARCHAR(30) NOT NULL DEFAULT 'Ouverte'`);
      await pgPool.query(`ALTER TABLE ${tbl} ADD COLUMN IF NOT EXISTS date_heure_fermeture VARCHAR(50) NULL`);
      await pgPool.query(`ALTER TABLE ${tbl} ADD COLUMN IF NOT EXISTS infos_en_cours TEXT NULL`);
      await pgPool.query(`ALTER TABLE ${tbl} ADD COLUMN IF NOT EXISTS issue_evacuation VARCHAR(120) NULL`);
    }

    for (const tbl of ['interventions', 'evacuations', 'evacuations_speciales']) {
      await pgPool.query(`ALTER TABLE ${tbl} ADD COLUMN IF NOT EXISTS type_patient VARCHAR(40) NOT NULL DEFAULT 'Etudiant'`);
      await pgPool.query(`ALTER TABLE ${tbl} ADD COLUMN IF NOT EXISTS service_agent_adresse VARCHAR(190) NULL`);
    }

    activeEngine = 'postgres';
    console.log(`[DB] Connecté à PostgreSQL (${getDbStatus().host})`);
  } catch (err) {
    console.warn(
      `[DB] PostgreSQL non joignable (${err.message}). Basculement automatique sur SQLite local (Ges_evac_db.sqlite).`
    );
    activeEngine = 'sqlite';
    const dbDir = path.join(__dirname, '..', 'database');
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    const sqlitePath = path.join(dbDir, 'Ges_evac_db.sqlite');
    sqliteDb = new DatabaseSync(sqlitePath);

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prenoms TEXT NOT NULL,
        nom TEXT NOT NULL,
        telephone TEXT NOT NULL,
        login TEXT NOT NULL UNIQUE,
        mot_de_passe TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'teleoperateur',
        statut TEXT NOT NULL DEFAULT 'approuve',
        reset_mot_de_passe TEXT DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS medecins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prenoms TEXT NOT NULL,
        nom TEXT NOT NULL,
        contact TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS services (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nom_service TEXT NOT NULL UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS equipes_secours (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        libelle TEXT NOT NULL UNIQUE,
        chef_equipe TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS lieux_prise_en_charge (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nom_lieu TEXT NOT NULL UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS interventions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        matricule TEXT NOT NULL,
        type_patient TEXT NOT NULL DEFAULT 'Etudiant',
        num_carte_etudiant TEXT NOT NULL,
        prenoms TEXT NOT NULL,
        nom TEXT NOT NULL,
        date_naissance TEXT NULL,
        lieu_naissance TEXT NULL,
        contact TEXT NULL,
        service_agent_adresse TEXT NULL,
        lieu_prise_en_charge TEXT NULL,
        destination TEXT NULL,
        plaintes TEXT NOT NULL,
        date_heure_intervention TEXT NOT NULL,
        agent_en_charge TEXT NOT NULL,
        user_id INTEGER NULL,
        user_nom TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS evacuations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        matricule TEXT NOT NULL DEFAULT '',
        type_patient TEXT NOT NULL DEFAULT 'Etudiant',
        num_carte_etudiant TEXT NOT NULL,
        prenoms TEXT NOT NULL,
        nom TEXT NOT NULL,
        contact TEXT NULL,
        service_agent_adresse TEXT NULL,
        motif TEXT NOT NULL,
        service TEXT NOT NULL DEFAULT 'Urgence',
        medecin TEXT NOT NULL,
        structure_evacuation TEXT NOT NULL,
        date_heure TEXT NOT NULL,
        statut_evacuation TEXT NOT NULL DEFAULT 'Ouverte',
        date_heure_fermeture TEXT NULL,
        infos_en_cours TEXT NULL,
        issue_evacuation TEXT NULL,
        user_id INTEGER NULL,
        user_nom TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS evacuations_speciales (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        matricule TEXT NOT NULL DEFAULT '',
        type_patient TEXT NOT NULL DEFAULT 'Etudiant',
        num_carte TEXT NOT NULL,
        prenoms TEXT NOT NULL,
        nom TEXT NOT NULL,
        contact TEXT NULL,
        service_agent_adresse TEXT NULL,
        service TEXT NOT NULL DEFAULT 'Urgence',
        motifs TEXT NOT NULL,
        regulation TEXT NOT NULL DEFAULT 'Non',
        accompagnement_medical TEXT NULL,
        medecin TEXT NOT NULL,
        structure TEXT NOT NULL,
        date_heure TEXT DEFAULT CURRENT_TIMESTAMP,
        statut_evacuation TEXT NOT NULL DEFAULT 'Ouverte',
        date_heure_fermeture TEXT NULL,
        infos_en_cours TEXT NULL,
        issue_evacuation TEXT NULL,
        user_id INTEGER NULL,
        user_nom TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    try {
      sqliteDb.exec(`ALTER TABLE interventions ADD COLUMN lieu_prise_en_charge TEXT NULL`);
    } catch {
      // Déjà existante
    }
    try {
      sqliteDb.exec(`ALTER TABLE interventions ADD COLUMN destination TEXT NULL`);
    } catch {
      // Déjà existante
    }
    try {
      sqliteDb.exec(`ALTER TABLE evacuations_speciales ADD COLUMN service TEXT NOT NULL DEFAULT 'Urgence'`);
    } catch {
      // Déjà existante
    }

    try {
      sqliteDb.exec(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'teleoperateur'`);
    } catch {
      // Déjà existante
    }
    try {
      sqliteDb.exec(`ALTER TABLE users ADD COLUMN statut TEXT NOT NULL DEFAULT 'approuve'`);
    } catch {
      // Déjà existante
    }
    try {
      sqliteDb.exec(`ALTER TABLE users ADD COLUMN reset_mot_de_passe TEXT DEFAULT NULL`);
    } catch {
      // Déjà existante
    }
    for (const tbl of ['evacuations', 'evacuations_speciales']) {
      try {
        sqliteDb.exec(`ALTER TABLE ${tbl} ADD COLUMN matricule TEXT NOT NULL DEFAULT ''`);
      } catch {
        // Déjà existante
      }
      try {
        sqliteDb.exec(`ALTER TABLE ${tbl} ADD COLUMN statut_evacuation TEXT NOT NULL DEFAULT 'Ouverte'`);
      } catch {
        // Déjà existante
      }
      try {
        sqliteDb.exec(`ALTER TABLE ${tbl} ADD COLUMN date_heure_fermeture TEXT NULL`);
      } catch {
        // Déjà existante
      }
      try {
        sqliteDb.exec(`ALTER TABLE ${tbl} ADD COLUMN infos_en_cours TEXT NULL`);
      } catch {
        // Déjà existante
      }
      try {
        sqliteDb.exec(`ALTER TABLE ${tbl} ADD COLUMN issue_evacuation TEXT NULL`);
      } catch {
        // Déjà existante
      }
    }
    for (const tbl of ['interventions', 'evacuations', 'evacuations_speciales']) {
      try {
        sqliteDb.exec(`ALTER TABLE ${tbl} ADD COLUMN type_patient TEXT NOT NULL DEFAULT 'Etudiant'`);
      } catch {
        // Déjà existante
      }
      try {
        sqliteDb.exec(`ALTER TABLE ${tbl} ADD COLUMN service_agent_adresse TEXT NULL`);
      } catch {
        // Déjà existante
      }
    }
  }

  await seedInitialData();
}

export async function query(sql, params = []) {
  if (activeEngine === 'postgres') {
    const trimmed = sql.trim();
    const upper = trimmed.toUpperCase();
    let pgSql = convertSqlToPostgres(trimmed);

    if (upper.startsWith('INSERT INTO') && !upper.includes('RETURNING')) {
      pgSql = `${pgSql} RETURNING id`;
    }

    const res = await pgPool.query(pgSql, params);
    if (upper.startsWith('SELECT')) {
      return res.rows;
    }
    return {
      insertId: res.rows?.[0]?.id ? Number(res.rows[0].id) : null,
      affectedRows: Number(res.rowCount || 0),
    };
  } else {
    const stmt = sqliteDb.prepare(sql);
    const trimmed = sql.trim().toUpperCase();
    if (trimmed.startsWith('SELECT')) {
      return stmt.all(...params);
    } else {
      const result = stmt.run(...params);
      return {
        insertId: Number(result.lastInsertRowid),
        affectedRows: Number(result.changes),
      };
    }
  }
}

export async function getNextInterventionMatricule() {
  const rows = await query('SELECT id, matricule FROM interventions ORDER BY id DESC LIMIT 1');
  if (!rows || rows.length === 0) {
    return formatMatricule(1);
  }
  const last = rows[0];
  const match = String(last.matricule || '').match(/INT_(\d+)/i);
  const nextNum = match ? Math.max(Number(match[1]) + 1, Number(last.id) + 1) : Number(last.id) + 1;
  return formatMatricule(nextNum);
}

export async function getNextEvacuationMatricule() {
  const rows = await query('SELECT id, matricule FROM evacuations ORDER BY id DESC LIMIT 1');
  if (!rows || rows.length === 0) {
    return formatEvacuationMatricule(1);
  }
  const last = rows[0];
  const match = String(last.matricule || '').match(/EVAC_(\d+)/i);
  const nextNum = match ? Math.max(Number(match[1]) + 1, Number(last.id) + 1) : Number(last.id) + 1;
  return formatEvacuationMatricule(nextNum);
}

export async function getNextEvacuationSpecialeMatricule() {
  const rows = await query('SELECT id, matricule FROM evacuations_speciales ORDER BY id DESC LIMIT 1');
  if (!rows || rows.length === 0) {
    return formatEvacuationSpecialeMatricule(1);
  }
  const last = rows[0];
  const match = String(last.matricule || '').match(/SPEC_(\d+)/i);
  const nextNum = match ? Math.max(Number(match[1]) + 1, Number(last.id) + 1) : Number(last.id) + 1;
  return formatEvacuationSpecialeMatricule(nextNum);
}

async function seedInitialData() {
  // 1. Services par défaut (Grand Campus + Services médicaux des sites)
  const defaultServices = [
    'Urgence (Grand Campus)',
    'Grand Campus : SME',
    'Grand Campus : SMP',
    'Service Médical Site : ESP',
    'Service Médical Site : Claudel',
    'Service Médical Site : École Normale',
    'Service Médical Site : ESEA',
    'Médecine Générale',
    'Chirurgie / Soins Infirmiers',
    'Gynécologie - Obstétrique',
    'Cabinet Dentaire',
    'Ophtalmologie',
    'Cardiologie',
  ];
  for (const srv of defaultServices) {
    try {
      const existing = await query('SELECT id FROM services WHERE nom_service = ?', [srv]);
      if (existing.length === 0) {
        await query('INSERT INTO services (nom_service) VALUES (?)', [srv]);
      }
    } catch {
      // Ignorer si doublon
    }
  }

  // 1b. Lieux de prise en charge par défaut
  const defaultLieux = [
    'Grand Campus',
    'Pavillon A (Grand Campus)',
    'Pavillon B (Grand Campus)',
    'Site : ESP',
    'Site : Claudel',
    'Site : École Normale',
    'Site : ESEA',
    'Terrain de sport',
    'Restaurant universitaire',
  ];
  for (const lieu of defaultLieux) {
    try {
      const existing = await query('SELECT id FROM lieux_prise_en_charge WHERE nom_lieu = ?', [lieu]);
      if (existing.length === 0) {
        await query('INSERT INTO lieux_prise_en_charge (nom_lieu) VALUES (?)', [lieu]);
      }
    } catch {
      // Ignorer si doublon
    }
  }

  // 2. Équipes de secours par défaut (id, libelle, chef_equipe)
  const existingEquipes = await query('SELECT COUNT(*) as count FROM equipes_secours');
  if (Number(existingEquipes[0].count) === 0) {
    const defaultEquipes = [
      ['Equipe 1', 'Moussa Fall'],
      ['Equipe 2', 'Abdoulaye Wade'],
      ['Equipe 3', 'Oumar Ndiaye'],
    ];
    for (const [libelle, chef] of defaultEquipes) {
      await query('INSERT INTO equipes_secours (libelle, chef_equipe) VALUES (?, ?)', [
        libelle,
        chef,
      ]);
    }
  }

  // 3. Comptes utilisateurs (Admin + Téléopérateur)
  const existingUsers = await query('SELECT COUNT(*) as count FROM users');
  if (Number(existingUsers[0].count) === 0) {
    await query(
      'INSERT INTO users (prenoms, nom, telephone, login, mot_de_passe, role) VALUES (?, ?, ?, ?, ?, ?)',
      ['Mamadou', 'Ndiaye', '77 450 12 34', 'admin', hashPassword('admin123'), 'admin']
    );
    await query(
      'INSERT INTO users (prenoms, nom, telephone, login, mot_de_passe, role) VALUES (?, ?, ?, ?, ?, ?)',
      ['Aïssatou', 'Gueye', '77 512 88 90', 'teleop', hashPassword('teleop123'), 'teleoperateur']
    );
  } else {
    // S'assurer que le compte 'admin' a bien le rôle 'admin'
    await query("UPDATE users SET role = 'admin' WHERE login = 'admin'");
    const teleopUser = await query("SELECT id FROM users WHERE login = 'teleop'");
    if (teleopUser.length === 0) {
      await query(
        'INSERT INTO users (prenoms, nom, telephone, login, mot_de_passe, role) VALUES (?, ?, ?, ?, ?, ?)',
        ['Aïssatou', 'Gueye', '77 512 88 90', 'teleop', hashPassword('teleop123'), 'teleoperateur']
      );
    }
  }

  // 4. Médecins par défaut
  const existingMedecins = await query('SELECT COUNT(*) as count FROM medecins');
  if (Number(existingMedecins[0].count) === 0) {
    const defaultMedecins = [
      ['Dr. Cheikh', 'Fall', '77 612 34 56'],
      ['Dr. Aminata', 'Diallo', '77 823 45 67'],
      ['Dr. Ibrahima', 'Sow', '76 534 56 78'],
      ['Dr. Fatou', 'Gueye', '78 145 67 89'],
    ];
    for (const [prenoms, nom, contact] of defaultMedecins) {
      await query('INSERT INTO medecins (prenoms, nom, contact) VALUES (?, ?, ?)', [prenoms, nom, contact]);
    }
  }

  // 5. Interventions par défaut (avec Équipe en charge : Libellé — Chef d'équipe)
  const existingInterventions = await query('SELECT COUNT(*) as count FROM interventions');
  if (Number(existingInterventions[0].count) === 0) {
    await query(
      `INSERT INTO interventions 
      (matricule, num_carte_etudiant, prenoms, nom, date_naissance, lieu_naissance, contact, plaintes, date_heure_intervention, agent_en_charge, user_id, user_nom)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'INT_000001',
        '202209841',
        'Ousmane',
        'Diop',
        '2002-04-15',
        'Saint-Louis',
        '77 321 90 11',
        'Céphalées intenses, fièvre à 39.2°C et courbatures depuis 48h (suspicion accès palustre).',
        '2026-11-01 09:30:00',
        'Equipe 1 — Moussa Fall',
        1,
        'Mamadou Ndiaye (admin)',
      ]
    );
    await query(
      `INSERT INTO interventions 
      (matricule, num_carte_etudiant, prenoms, nom, date_naissance, lieu_naissance, contact, plaintes, date_heure_intervention, agent_en_charge, user_id, user_nom)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'INT_000002',
        '202311402',
        'Mariama',
        'Ba',
        '2003-11-22',
        'Thiès',
        '78 412 55 80',
        'Douleurs épigastriques aiguës accompagnées de vertiges après le repas.',
        '2026-11-01 11:15:00',
        'Equipe 2 — Abdoulaye Wade',
        2,
        'Aïssatou Gueye (teleop)',
      ]
    );
    await query(
      `INSERT INTO interventions 
      (matricule, num_carte_etudiant, prenoms, nom, date_naissance, lieu_naissance, contact, plaintes, date_heure_intervention, agent_en_charge, user_id, user_nom)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'INT_000003',
        '202315890',
        'Khadija',
        'Sy',
        '2004-02-10',
        'Dakar',
        '77 605 44 19',
        "Crise d'asthme aiguë avec dyspnée sifflante et gêne respiratoire nocturne (étudiante asthmatique connue).",
        '2026-11-01 15:40:00',
        'Equipe 1 — Moussa Fall',
        1,
        'Mamadou Ndiaye (admin)',
      ]
    );
  } else {
    const asthmeRows = await query(
      "SELECT id FROM interventions WHERE plaintes LIKE '%asthme%' OR plaintes LIKE '%asthmatique%'"
    );
    if (asthmeRows.length === 0) {
      const nextMat = await getNextInterventionMatricule();
      await query(
        `INSERT INTO interventions 
        (matricule, num_carte_etudiant, prenoms, nom, date_naissance, lieu_naissance, contact, plaintes, date_heure_intervention, agent_en_charge, user_id, user_nom)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          nextMat,
          '202315890',
          'Khadija',
          'Sy',
          '2004-02-10',
          'Dakar',
          '77 605 44 19',
          "Crise d'asthme aiguë avec dyspnée sifflante et gêne respiratoire nocturne (étudiante asthmatique connue).",
          '2026-11-01 15:40:00',
          'Equipe 1 — Moussa Fall',
          1,
          'Mamadou Ndiaye (admin)',
        ]
      );
    }
  }

  const existingEvacs = await query('SELECT COUNT(*) as count FROM evacuations');
  if (Number(existingEvacs[0].count) === 0) {
    await query(
      `INSERT INTO evacuations
      (matricule, num_carte_etudiant, prenoms, nom, contact, motif, service, medecin, structure_evacuation, date_heure, user_id, user_nom)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'EVAC_000001',
        '202209841',
        'Ousmane',
        'Diop',
        '77 321 90 11',
        'Syndrome fébrile aigu persistant nécessitant un bilan biologique complet et mise en observation.',
        'Urgence',
        'Dr. Cheikh Fall',
        'CHU de Fann',
        '2026-11-01 10:15:00',
        1,
        'Mamadou Ndiaye (admin)',
      ]
    );
  } else {
    const missingEvacMat = await query(
      "SELECT id FROM evacuations WHERE matricule IS NULL OR matricule = ''"
    );
    for (const row of missingEvacMat) {
      await query('UPDATE evacuations SET matricule = ? WHERE id = ?', [
        formatEvacuationMatricule(row.id),
        row.id,
      ]);
    }
  }

  const existingEvacSpec = await query('SELECT COUNT(*) as count FROM evacuations_speciales');
  if (Number(existingEvacSpec[0].count) === 0) {
    await query(
      `INSERT INTO evacuations_speciales
      (matricule, num_carte, prenoms, nom, contact, motifs, regulation, accompagnement_medical, medecin, structure, date_heure, user_id, user_nom)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'SPEC_000001',
        '202104519',
        'Mouhamed',
        'Sarr',
        '77 908 33 21',
        'Traumatisme crânien suite à une chute sur le terrain de sport du campus avec perte de connaissance brève.',
        'Oui',
        'Ambulance médicalisée COUD + Infirmier de garde',
        'Dr. Ibrahima Sow',
        'Hôpital Principal de Dakar',
        '2026-11-01 14:20:00',
        1,
        'Mamadou Ndiaye (admin)',
      ]
    );
  } else {
    const missingSpecMat = await query(
      "SELECT id FROM evacuations_speciales WHERE matricule IS NULL OR matricule = ''"
    );
    for (const row of missingSpecMat) {
      await query('UPDATE evacuations_speciales SET matricule = ? WHERE id = ?', [
        formatEvacuationSpecialeMatricule(row.id),
        row.id,
      ]);
    }
  }
}
