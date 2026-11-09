import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  initDatabase,
  query,
  hashPassword,
  getDbStatus,
  getNextInterventionMatricule,
  getNextEvacuationMatricule,
  getNextEvacuationSpecialeMatricule,
} from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 3001);
const SECRET_PORT = Number(process.env.SECRET_PORT || 58492);
// Sous-domaine et chemin chiffrés confidentiels pour accéder à l'application
const SECRET_SUBDOMAIN = 'coud-9f8a2d7e4b1c.localhost';
const SECRET_PATH = process.env.SECRET_URL_PATH || '/coud-8f9a2d7e4b1c6a3f';

app.use(cors());
app.use(express.json());

function normalizeMedicalText(str = '') {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function formatCarteOrCin(val = '') {
  return String(val || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function formatPrenoms(val = '') {
  return String(val || '')
    .trim()
    .replace(/(^|[\s'-])(\p{L})(\p{L}*)/gu, (_, sep, first, rest) => `${sep}${first.toUpperCase()}${rest.toLowerCase()}`);
}

function formatNom(val = '') {
  return String(val || '').trim().toUpperCase();
}

function formatContact(val = '') {
  const digits = String(val || '').replace(/\D/g, '').slice(0, 9);
  const parts = [];
  if (digits.length > 0) parts.push(digits.slice(0, 2));
  if (digits.length > 2) parts.push(digits.slice(2, 5));
  if (digits.length > 5) parts.push(digits.slice(5, 7));
  if (digits.length > 7) parts.push(digits.slice(7, 9));
  return parts.join(' ');
}

const MEDICAL_SYNONYM_GROUPS = [
  ['asthme', 'asthmatique', 'asthmatiques', 'asthm', 'dyspnee sifflante', 'bronchospasme'],
  ['paludisme', 'palustre', 'paludeen', 'palu', 'fievre', 'febrile', 'acces palustre'],
  ['cephalee', 'cephalees', 'migraine', 'migraines', 'maux de tete'],
  ['gastro', 'gastrite', 'epigastrique', 'epigastralgie', 'douleurs abdominales', 'vomissement', 'diarrhee'],
  ['traumatisme', 'traumatique', 'trauma', 'fracture', 'entorse', 'chute', 'contusion', 'plaie'],
  ['diabete', 'diabetique', 'diabetiques', 'hypoglycemie', 'hyperglycemie'],
  ['hypertension', 'hypertendu', 'hypertendue', 'hta', 'poussee hypertensive'],
  ['epilepsie', 'epileptique', 'epileptiques', 'convulsion', 'convulsions', 'perte de connaissance'],
  ['detresse respiratoire', 'respiratoire', 'dyspnee', 'essoufflement'],
  ['appendicite', 'appendiculaire', 'fosse iliaque'],
];

function expandMedicalTerms(rawQuery = '') {
  const norm = normalizeMedicalText(rawQuery);
  if (!norm) return [];
  const terms = new Set([norm]);

  if (norm.length > 4 && (norm.endsWith('s') || norm.endsWith('x'))) {
    terms.add(norm.slice(0, -1));
  }
  if (norm.endsWith('atique') || norm.endsWith('atiques')) {
    terms.add(norm.replace(/atiques?$/, ''));
  }
  if (norm.endsWith('ique') || norm.endsWith('iques')) {
    terms.add(norm.replace(/iques?$/, ''));
  }

  for (const group of MEDICAL_SYNONYM_GROUPS) {
    if (group.some((w) => norm.includes(w) || w.includes(norm))) {
      for (const w of group) terms.add(w);
    }
  }
  return Array.from(terms).filter((t) => t.length >= 2);
}

function matchesMedicalSearch(fields = [], rawQuery = '') {
  const normQuery = normalizeMedicalText(rawQuery);
  if (!normQuery) return true;
  const combined = normalizeMedicalText(fields.filter(Boolean).join(' '));
  if (combined.includes(normQuery)) return true;
  const expanded = expandMedicalTerms(rawQuery);
  return expanded.some((term) => combined.includes(term));
}

const SYMPTOM_CATEGORIES = [
  {
    label: 'Asthme / Détresse respiratoire / Dyspnée',
    keywords: ['asthm', 'dyspn', 'respirat', 'bronchospasme', 'essouffl'],
  },
  {
    label: 'Paludisme / Syndrome fébrile / Fièvre',
    keywords: ['palu', 'fievr', 'febril', 'frisson', 'courbatur'],
  },
  {
    label: 'Céphalées / Migraines / Vertiges',
    keywords: ['cephal', 'migrain', 'maux de tete', 'vertig'],
  },
  {
    label: 'Troubles digestifs / Douleurs épigastriques / Gastro-entérite',
    keywords: ['gastr', 'epigastr', 'abdomin', 'vomiss', 'diarrh', 'intoxic', 'colique'],
  },
  {
    label: 'Traumatologie / Chutes / Blessures sportives',
    keywords: ['trauma', 'chut', 'fractur', 'entors', 'plaie', 'contusion', 'luxation'],
  },
  {
    label: 'Épilepsie / Convulsions / Malaise & Perte de connaissance',
    keywords: ['epilep', 'convuls', 'perte de connaissance', 'malaise', 'syncope'],
  },
  {
    label: 'Pathologies cardiovasculaires / HTA / Douleurs thoraciques',
    keywords: ['hypertens', 'hta', 'thorac', 'cardiaq', 'palpitat', 'tension'],
  },
  {
    label: 'Diabète / Urgences métaboliques',
    keywords: ['diab', 'glycem', 'hypoglyc', 'hyperglyc'],
  },
  {
    label: 'Urgences chirurgicales / Appendicite',
    keywords: ['appendic', 'chirurg', 'fosse iliaque', 'hernie'],
  },
];

function classifySymptomCategory(text = '') {
  const norm = normalizeMedicalText(text);
  for (const cat of SYMPTOM_CATEGORIES) {
    if (cat.keywords.some((kw) => norm.includes(kw))) {
      return cat.label;
    }
  }
  return 'Autres plaintes & motifs médicaux';
}

app.get('/api/status', (req, res) => {
  res.json({
    status: 'ok',
    db: getDbStatus(),
    secretPath: SECRET_PATH,
    secretSubdomain: SECRET_SUBDOMAIN,
    secretPort: SECRET_PORT,
  });
});

function canModifyRecord(record, reqUserId, reqUserRole, reqUserLogin) {
  if (reqUserRole === 'admin') return true;
  if (!record) return false;
  if (reqUserId && Number(record.user_id) === Number(reqUserId)) return true;
  if (reqUserLogin && String(record.user_nom || '').includes(`(${reqUserLogin})`)) return true;
  return false;
}

// ============================================================================
// 1 & 2. AUTHENTIFICATION & GESTION DES COMPTES UTILISATEURS
// ============================================================================

app.post('/api/auth/login', async (req, res) => {
  try {
    const { login, mot_de_passe } = req.body;
    if (!login || !mot_de_passe) {
      return res.status(400).json({ error: 'Veuillez renseigner votre login et votre mot de passe.' });
    }

    const hashed = hashPassword(mot_de_passe);
    const users = await query(
      'SELECT id, prenoms, nom, telephone, login, role, statut, created_at FROM users WHERE login = ? AND (mot_de_passe = ? OR mot_de_passe = ?)',
      [login.trim(), hashed, mot_de_passe]
    );

    if (users.length === 0) {
      return res.status(401).json({ error: 'Identifiants incorrects. Vérifiez votre login ou mot de passe.' });
    }

    const user = users[0];
    if (user.statut === 'en_attente' && user.login !== 'admin') {
      return res.status(403).json({
        error: "Votre compte est en attente d'approbation par un administrateur.",
      });
    }

    const role = user.role || (user.login === 'admin' ? 'admin' : 'teleoperateur');
    res.json({
      user: {
        id: user.id,
        prenoms: user.prenoms,
        nom: user.nom,
        telephone: user.telephone,
        login: user.login,
        role,
        statut: user.statut || 'approuve',
        nom_complet: `${user.prenoms} ${user.nom}`,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const {
      prenoms,
      nom,
      telephone,
      login,
      mot_de_passe,
      confirmer_mot_de_passe,
      role,
      request_user_role,
    } = req.body;

    if (!prenoms || !nom || !telephone || !login || !mot_de_passe || !confirmer_mot_de_passe) {
      return res.status(400).json({ error: 'Tous les champs sont obligatoires.' });
    }

    if (mot_de_passe !== confirmer_mot_de_passe) {
      return res.status(400).json({ error: 'Le mot de passe et sa confirmation ne correspondent pas.' });
    }

    if (String(mot_de_passe).length < 4) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 4 caractères.' });
    }

    const existing = await query('SELECT id FROM users WHERE login = ?', [login.trim()]);
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Ce login est déjà utilisé par un autre compte.' });
    }

    const assignedRole = role === 'admin' ? 'admin' : 'teleoperateur';
    const assignedStatut = request_user_role === 'admin' ? 'approuve' : 'en_attente';
    const hashed = hashPassword(mot_de_passe);
    const cleanPrenoms = formatPrenoms(prenoms);
    const cleanNom = formatNom(nom);
    const cleanTel = formatContact(telephone);
    const result = await query(
      'INSERT INTO users (prenoms, nom, telephone, login, mot_de_passe, role, statut) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [cleanPrenoms, cleanNom, cleanTel, login.trim(), hashed, assignedRole, assignedStatut]
    );

    res.status(201).json({
      id: result.insertId,
      prenoms: cleanPrenoms,
      nom: cleanNom,
      telephone: cleanTel,
      login: login.trim(),
      role: assignedRole,
      statut: assignedStatut,
      nom_complet: `${cleanPrenoms} ${cleanNom}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/reset-request', async (req, res) => {
  try {
    const { login, telephone, mot_de_passe, confirmer_mot_de_passe } = req.body;
    if (!login || !telephone || !mot_de_passe || !confirmer_mot_de_passe) {
      return res.status(400).json({ error: 'Tous les champs sont obligatoires.' });
    }
    if (mot_de_passe !== confirmer_mot_de_passe) {
      return res.status(400).json({ error: 'Le nouveau mot de passe et sa confirmation ne correspondent pas.' });
    }
    if (String(mot_de_passe).length < 4) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 4 caractères.' });
    }

    const users = await query('SELECT id, login, telephone FROM users WHERE login = ?', [login.trim()]);
    if (users.length === 0) {
      return res.status(404).json({ error: 'Aucun compte trouvé avec ce login.' });
    }

    const user = users[0];
    const dbTelDigits = String(user.telephone || '').replace(/\D/g, '');
    const reqTelDigits = String(telephone || '').replace(/\D/g, '');
    if (!dbTelDigits || dbTelDigits !== reqTelDigits) {
      return res.status(400).json({
        error: 'Le numéro de téléphone ne correspond pas à celui associé à ce compte.',
      });
    }

    const hashed = hashPassword(mot_de_passe);
    await query('UPDATE users SET reset_mot_de_passe = ? WHERE id = ?', [hashed, user.id]);

    res.json({
      success: true,
      message:
        'Demande enregistrée avec succès. Votre nouveau mot de passe sera actif dès son approbation par un administrateur.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users', async (req, res) => {
  try {
    const { userId, role } = req.query;
    const selectCols =
      "id, prenoms, nom, telephone, login, role, statut, CASE WHEN reset_mot_de_passe IS NOT NULL AND reset_mot_de_passe != '' THEN 1 ELSE 0 END AS demande_reset, created_at";
    if (role && role !== 'admin' && userId) {
      const rows = await query(
        `SELECT ${selectCols} FROM users WHERE id = ?`,
        [userId]
      );
      return res.json(rows);
    }
    const rows = await query(
      `SELECT ${selectCols} FROM users ORDER BY id DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/users/:id/approve', async (req, res) => {
  try {
    const { request_user_role } = req.body;
    if (request_user_role !== 'admin') {
      return res.status(403).json({
        error: "Seul un administrateur peut approuver un compte utilisateur.",
      });
    }
    await query("UPDATE users SET statut = 'approuve' WHERE id = ?", [req.params.id]);
    const updated = await query(
      "SELECT id, prenoms, nom, telephone, login, role, statut, CASE WHEN reset_mot_de_passe IS NOT NULL AND reset_mot_de_passe != '' THEN 1 ELSE 0 END AS demande_reset, created_at FROM users WHERE id = ?",
      [req.params.id]
    );
    res.json(updated[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/users/:id/approve-reset', async (req, res) => {
  try {
    const { request_user_role } = req.body;
    if (request_user_role !== 'admin') {
      return res.status(403).json({
        error: "Seul un administrateur peut approuver la réinitialisation d'un mot de passe.",
      });
    }
    const rows = await query('SELECT id, reset_mot_de_passe FROM users WHERE id = ?', [req.params.id]);
    if (!rows.length || !rows[0].reset_mot_de_passe) {
      return res.status(400).json({ error: 'Aucune demande de réinitialisation en attente pour ce compte.' });
    }
    await query(
      'UPDATE users SET mot_de_passe = reset_mot_de_passe, reset_mot_de_passe = NULL WHERE id = ?',
      [req.params.id]
    );
    const updated = await query(
      "SELECT id, prenoms, nom, telephone, login, role, statut, CASE WHEN reset_mot_de_passe IS NOT NULL AND reset_mot_de_passe != '' THEN 1 ELSE 0 END AS demande_reset, created_at FROM users WHERE id = ?",
      [req.params.id]
    );
    res.json(updated[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/users/:id', async (req, res) => {
  try {
    const {
      prenoms,
      nom,
      telephone,
      login,
      mot_de_passe,
      confirmer_mot_de_passe,
      role,
      request_user_id,
      request_user_role,
    } = req.body;

    if (
      request_user_role &&
      request_user_role !== 'admin' &&
      Number(request_user_id) !== Number(req.params.id)
    ) {
      return res.status(403).json({ error: 'Vous ne pouvez modifier que votre propre compte.' });
    }

    if (!prenoms || !nom || !telephone || !login) {
      return res.status(400).json({ error: 'Prénoms, nom, téléphone et login sont obligatoires.' });
    }

    const existing = await query('SELECT id FROM users WHERE login = ? AND id != ?', [
      login.trim(),
      req.params.id,
    ]);
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Ce login est déjà attribué à un autre utilisateur.' });
    }

    const currentRows = await query('SELECT role FROM users WHERE id = ?', [req.params.id]);
    const currentRole = currentRows[0]?.role || 'teleoperateur';
    const nextRole =
      request_user_role === 'admin' && role
        ? role === 'admin'
          ? 'admin'
          : 'teleoperateur'
        : currentRole;

    const cleanPrenoms = formatPrenoms(prenoms);
    const cleanNom = formatNom(nom);
    const cleanTel = formatContact(telephone);

    if (mot_de_passe) {
      if (mot_de_passe !== confirmer_mot_de_passe) {
        return res.status(400).json({ error: 'Le mot de passe et sa confirmation ne correspondent pas.' });
      }
      const hashed = hashPassword(mot_de_passe);
      await query(
        'UPDATE users SET prenoms = ?, nom = ?, telephone = ?, login = ?, mot_de_passe = ?, reset_mot_de_passe = NULL, role = ? WHERE id = ?',
        [cleanPrenoms, cleanNom, cleanTel, login.trim(), hashed, nextRole, req.params.id]
      );
    } else {
      await query(
        'UPDATE users SET prenoms = ?, nom = ?, telephone = ?, login = ?, role = ? WHERE id = ?',
        [cleanPrenoms, cleanNom, cleanTel, login.trim(), nextRole, req.params.id]
      );
    }

    const updated = await query(
      "SELECT id, prenoms, nom, telephone, login, role, statut, CASE WHEN reset_mot_de_passe IS NOT NULL AND reset_mot_de_passe != '' THEN 1 ELSE 0 END AS demande_reset, created_at FROM users WHERE id = ?",
      [req.params.id]
    );
    res.json(updated[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/users/:id', async (req, res) => {
  try {
    const { role } = req.query;
    if (role && role !== 'admin') {
      return res.status(403).json({ error: "Seul l'administrateur peut supprimer un compte." });
    }
    const countRows = await query('SELECT COUNT(*) as count FROM users');
    if (Number(countRows[0].count) <= 1) {
      return res.status(400).json({ error: 'Impossible de supprimer le dernier compte utilisateur.' });
    }
    await query('DELETE FROM users WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// AUTO-COMPLÉTION & HISTORIQUE COMPLET D'UN ÉTUDIANT (BOUTON DÉTAILS)
// ============================================================================

app.get('/api/etudiants/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const like = `%${q}%`;

    const interventions = await query(
      `SELECT matricule, type_patient, num_carte_etudiant as num_carte, prenoms, nom, date_naissance, lieu_naissance, contact, service_agent_adresse
       FROM interventions
       WHERE num_carte_etudiant LIKE ? OR matricule LIKE ? OR prenoms LIKE ? OR nom LIKE ?
       ORDER BY id DESC LIMIT 15`,
      [like, like, like, like]
    );

    const evacuations = await query(
      `SELECT matricule, type_patient, num_carte_etudiant as num_carte, prenoms, nom, NULL as date_naissance, NULL as lieu_naissance, contact, service_agent_adresse
       FROM evacuations
       WHERE num_carte_etudiant LIKE ? OR matricule LIKE ? OR prenoms LIKE ? OR nom LIKE ?
       ORDER BY id DESC LIMIT 15`,
      [like, like, like, like]
    );

    const evacSpec = await query(
      `SELECT matricule, type_patient, num_carte, prenoms, nom, NULL as date_naissance, NULL as lieu_naissance, contact, service_agent_adresse
       FROM evacuations_speciales
       WHERE num_carte LIKE ? OR matricule LIKE ? OR prenoms LIKE ? OR nom LIKE ?
       ORDER BY id DESC LIMIT 15`,
      [like, like, like, like]
    );

    const map = new Map();
    for (const item of [...interventions, ...evacuations, ...evacSpec]) {
      const key = item.num_carte || `${item.prenoms}-${item.nom}`;
      if (!map.has(key)) {
        map.set(key, item);
      } else {
        const prev = map.get(key);
        map.set(key, {
          matricule: prev.matricule || item.matricule || '',
          type_patient: prev.type_patient || item.type_patient || 'Etudiant',
          num_carte: prev.num_carte || item.num_carte || '',
          prenoms: prev.prenoms || item.prenoms || '',
          nom: prev.nom || item.nom || '',
          date_naissance: prev.date_naissance || item.date_naissance || '',
          lieu_naissance: prev.lieu_naissance || item.lieu_naissance || '',
          contact: prev.contact || item.contact || '',
          service_agent_adresse: prev.service_agent_adresse || item.service_agent_adresse || '',
        });
      }
    }

    res.json(Array.from(map.values()).slice(0, 10));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Historique médical complet d'une personne donnée (Civilité, Nb admissions urgence, Symptômes, Date/Heure)
app.get('/api/etudiants/historique/:numCarte', async (req, res) => {
  try {
    const numCarte = String(req.params.numCarte || '').trim();
    if (!numCarte) {
      return res.status(400).json({ error: 'Numéro de carte requis.' });
    }

    const interventions = await query(
      'SELECT * FROM interventions WHERE num_carte_etudiant = ? ORDER BY date_heure_intervention DESC, id DESC',
      [numCarte]
    );

    const evacuations = await query(
      'SELECT * FROM evacuations WHERE num_carte_etudiant = ? ORDER BY date_heure DESC, id DESC',
      [numCarte]
    );

    const evacSpec = await query(
      'SELECT * FROM evacuations_speciales WHERE num_carte = ? ORDER BY date_heure DESC, id DESC',
      [numCarte]
    );

    // Civilité consolidée
    const civilite = {
      type_patient: 'Etudiant',
      num_carte: numCarte,
      prenoms: '',
      nom: '',
      date_naissance: '',
      lieu_naissance: '',
      contact: '',
      service_agent_adresse: '',
    };

    for (const row of [...interventions, ...evacuations, ...evacSpec]) {
      if (row.type_patient && civilite.type_patient === 'Etudiant') {
        civilite.type_patient = row.type_patient;
      }
      if (!civilite.prenoms && row.prenoms) civilite.prenoms = row.prenoms;
      if (!civilite.nom && row.nom) civilite.nom = row.nom;
      if (!civilite.date_naissance && row.date_naissance) civilite.date_naissance = row.date_naissance;
      if (!civilite.lieu_naissance && row.lieu_naissance) civilite.lieu_naissance = row.lieu_naissance;
      if (!civilite.contact && row.contact) civilite.contact = row.contact;
      if (!civilite.service_agent_adresse && row.service_agent_adresse) {
        civilite.service_agent_adresse = row.service_agent_adresse;
      }
    }

    // Liste unifiée de tous les passages (Interventions, Évacuations, Évacuations Spéciales)
    const historique = [
      ...interventions.map((i) => ({
        uid: `INT-${i.id}`,
        acte_type: 'Intervention (Urgence)',
        reference: i.matricule,
        symptomes: [
          i.plaintes,
          i.lieu_prise_en_charge ? `Lieu de prise en charge : ${i.lieu_prise_en_charge}` : '',
          i.destination ? `Destination : ${i.destination}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        service: i.destination || 'Urgence / Soins',
        prise_en_charge: i.agent_en_charge,
        date_heure: i.date_heure_intervention || i.created_at,
        user_nom: i.user_nom,
      })),
      ...evacuations.map((e) => ({
        uid: `EVAC-${e.id}`,
        acte_type: `Évacuation (${e.statut_evacuation || 'Ouverte'})`,
        reference: e.matricule || `EVAC_${String(e.id).padStart(6, '0')}`,
        symptomes: [
          e.motif,
          e.infos_en_cours ? `Parcours / Infos en cours :\n${e.infos_en_cours}` : '',
          e.issue_evacuation ? `Issue : ${e.issue_evacuation}` : '',
          e.date_heure_fermeture ? `Fermée le : ${e.date_heure_fermeture}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        service: e.service || 'Urgence',
        prise_en_charge: `${e.medecin} → ${e.structure_evacuation}`,
        date_heure: e.date_heure || e.created_at,
        user_nom: e.user_nom,
      })),
      ...evacSpec.map((es) => ({
        uid: `SPEC-${es.id}`,
        acte_type: `Évacuation Spéciale (${es.statut_evacuation || 'Ouverte'})`,
        reference: es.matricule || `SPEC_${String(es.id).padStart(6, '0')}`,
        symptomes: [
          es.motifs,
          es.infos_en_cours ? `Parcours / Infos en cours :\n${es.infos_en_cours}` : '',
          es.issue_evacuation ? `Issue : ${es.issue_evacuation}` : '',
          es.date_heure_fermeture ? `Fermée le : ${es.date_heure_fermeture}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        service: `${es.service || 'Urgence'} (Régulation: ${es.regulation})`,
        prise_en_charge: `${es.medecin} → ${es.structure}`,
        date_heure: es.date_heure || es.created_at,
        user_nom: es.user_nom,
      })),
    ].sort((a, b) => String(b.date_heure || '').localeCompare(String(a.date_heure || '')));

    const nbUrgences =
      interventions.length +
      evacuations.filter((e) => String(e.service || '').toLowerCase() === 'urgence').length +
      evacSpec.length;

    res.json({
      civilite,
      stats: {
        nb_admissions_urgence: nbUrgences,
        nb_interventions: interventions.length,
        nb_evacuations: evacuations.length,
        nb_evacuations_speciales: evacSpec.length,
        total_passages: historique.length,
      },
      historique,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// 3. INTERVENTIONS & LIEUX DE PRISE EN CHARGE
// ============================================================================

async function saveLieuPriseEnChargeIfNeeded(lieu) {
  const clean = String(lieu || '').trim();
  if (!clean) return;
  try {
    const existing = await query('SELECT id FROM lieux_prise_en_charge WHERE LOWER(nom_lieu) = LOWER(?)', [
      clean,
    ]);
    if (existing.length === 0) {
      await query('INSERT INTO lieux_prise_en_charge (nom_lieu) VALUES (?)', [clean]);
    }
  } catch {
    // Ignorer si doublon
  }
}

app.get('/api/lieux-prise-en-charge', async (req, res) => {
  try {
    const savedRows = await query('SELECT nom_lieu FROM lieux_prise_en_charge ORDER BY id ASC');
    const usedRows = await query(
      "SELECT lieu_prise_en_charge FROM interventions WHERE lieu_prise_en_charge IS NOT NULL AND lieu_prise_en_charge != '' ORDER BY id DESC"
    );
    const set = new Set();
    for (const r of savedRows) {
      if (r.nom_lieu) set.add(String(r.nom_lieu).trim());
    }
    for (const r of usedRows) {
      if (r.lieu_prise_en_charge) set.add(String(r.lieu_prise_en_charge).trim());
    }
    res.json(Array.from(set));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/interventions/next-matricule', async (req, res) => {
  try {
    const matricule = await getNextInterventionMatricule();
    res.json({ matricule });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/interventions', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const rows = await query('SELECT * FROM interventions ORDER BY id DESC');
    if (q) {
      const filtered = rows.filter((r) =>
        matchesMedicalSearch(
          [
            r.matricule,
            r.type_patient,
            r.num_carte_etudiant,
            r.prenoms,
            r.nom,
            r.contact,
            r.service_agent_adresse,
            r.lieu_prise_en_charge,
            r.destination,
            r.plaintes,
            r.agent_en_charge,
            r.user_nom,
          ],
          q
        )
      );
      return res.json(filtered);
    }
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/interventions', async (req, res) => {
  try {
    const {
      type_patient = 'Etudiant',
      num_carte_etudiant,
      prenoms,
      nom,
      date_naissance,
      lieu_naissance,
      contact,
      service_agent_adresse,
      lieu_prise_en_charge,
      destination,
      plaintes,
      date_heure_intervention,
      agent_en_charge,
      user_id,
      user_nom,
    } = req.body;

    if (!num_carte_etudiant || !prenoms || !nom || !plaintes || !date_heure_intervention || !agent_en_charge) {
      return res.status(400).json({ error: "Veuillez remplir tous les champs obligatoires de l'intervention." });
    }

    const autoMatricule = await getNextInterventionMatricule();
    const cleanType = ['Etudiant', 'Agent', 'Externe'].includes(type_patient) ? type_patient : 'Etudiant';
    const cleanExtra =
      cleanType === 'Etudiant'
        ? null
        : service_agent_adresse
          ? String(service_agent_adresse).trim()
          : null;

    const cleanLieu = lieu_prise_en_charge ? String(lieu_prise_en_charge).trim() : null;
    if (cleanLieu) {
      await saveLieuPriseEnChargeIfNeeded(cleanLieu);
    }

    const result = await query(
      `INSERT INTO interventions
      (matricule, type_patient, num_carte_etudiant, prenoms, nom, date_naissance, lieu_naissance, contact, service_agent_adresse, lieu_prise_en_charge, destination, plaintes, date_heure_intervention, agent_en_charge, user_id, user_nom)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        autoMatricule,
        cleanType,
        formatCarteOrCin(num_carte_etudiant),
        formatPrenoms(prenoms),
        formatNom(nom),
        date_naissance || null,
        lieu_naissance ? lieu_naissance.trim() : null,
        contact ? formatContact(contact) || null : null,
        cleanExtra,
        cleanLieu,
        destination ? String(destination).trim() : null,
        plaintes.trim(),
        date_heure_intervention,
        agent_en_charge.trim(),
        user_id || null,
        user_nom || 'Utilisateur',
      ]
    );

    const created = await query('SELECT * FROM interventions WHERE id = ?', [result.insertId]);
    res.status(201).json(created[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/interventions/:id', async (req, res) => {
  try {
    const existingRows = await query('SELECT * FROM interventions WHERE id = ?', [req.params.id]);
    if (existingRows.length === 0) {
      return res.status(404).json({ error: 'Intervention introuvable.' });
    }

    const {
      type_patient = 'Etudiant',
      num_carte_etudiant,
      prenoms,
      nom,
      date_naissance,
      lieu_naissance,
      contact,
      service_agent_adresse,
      lieu_prise_en_charge,
      destination,
      plaintes,
      date_heure_intervention,
      agent_en_charge,
      request_user_id,
      request_user_role,
      request_user_login,
    } = req.body;

    if (!canModifyRecord(existingRows[0], request_user_id, request_user_role, request_user_login)) {
      return res.status(403).json({
        error: 'Accès refusé : vous ne pouvez modifier que les interventions que vous avez enregistrées.',
      });
    }

    const cleanType = ['Etudiant', 'Agent', 'Externe'].includes(type_patient) ? type_patient : 'Etudiant';
    const cleanExtra =
      cleanType === 'Etudiant'
        ? null
        : service_agent_adresse
          ? String(service_agent_adresse).trim()
          : null;

    const cleanLieu = lieu_prise_en_charge ? String(lieu_prise_en_charge).trim() : null;
    if (cleanLieu) {
      await saveLieuPriseEnChargeIfNeeded(cleanLieu);
    }

    await query(
      `UPDATE interventions SET
        type_patient = ?, num_carte_etudiant = ?, prenoms = ?, nom = ?, date_naissance = ?,
        lieu_naissance = ?, contact = ?, service_agent_adresse = ?, lieu_prise_en_charge = ?, destination = ?, plaintes = ?, date_heure_intervention = ?, agent_en_charge = ?
       WHERE id = ?`,
      [
        cleanType,
        formatCarteOrCin(num_carte_etudiant),
        formatPrenoms(prenoms),
        formatNom(nom),
        date_naissance || null,
        lieu_naissance || null,
        contact ? formatContact(contact) || null : null,
        cleanExtra,
        cleanLieu,
        destination ? String(destination).trim() : null,
        plaintes,
        date_heure_intervention,
        agent_en_charge,
        req.params.id,
      ]
    );

    const updated = await query('SELECT * FROM interventions WHERE id = ?', [req.params.id]);
    res.json(updated[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/interventions/:id', async (req, res) => {
  try {
    const existingRows = await query('SELECT * FROM interventions WHERE id = ?', [req.params.id]);
    if (existingRows.length === 0) {
      return res.status(404).json({ error: 'Intervention introuvable.' });
    }
    const { userId, role, login } = req.query;
    if (!canModifyRecord(existingRows[0], userId, role, login)) {
      return res.status(403).json({
        error: 'Accès refusé : vous ne pouvez supprimer que vos propres interventions.',
      });
    }

    await query('DELETE FROM interventions WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// 4. ÉVACUATIONS (CLASSIQUES)
// ============================================================================

app.get('/api/evacuations/next-matricule', async (req, res) => {
  try {
    const matricule = await getNextEvacuationMatricule();
    res.json({ matricule });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Liste de toutes les évacuations / gardes actuellement ouvertes (classiques et spéciales)
app.get('/api/evacuations-ouvertes', async (req, res) => {
  try {
    const evacs = await query(
      "SELECT id, matricule, num_carte_etudiant AS num_carte, prenoms, nom, service, structure_evacuation AS structure, medecin, date_heure, statut_evacuation, infos_en_cours, user_nom FROM evacuations WHERE statut_evacuation = 'Ouverte' ORDER BY id DESC"
    );
    const evacSpecs = await query(
      "SELECT id, matricule, num_carte, prenoms, nom, service, structure, medecin, date_heure, statut_evacuation, infos_en_cours, user_nom FROM evacuations_speciales WHERE statut_evacuation = 'Ouverte' ORDER BY id DESC"
    );
    res.json({
      evacuations: evacs.map((e) => ({ ...e, type_acte: 'evacuation' })),
      evacuations_speciales: evacSpecs.map((es) => ({ ...es, type_acte: 'evacuation_speciale' })),
      total: evacs.length + evacSpecs.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/evacuations', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const rows = await query('SELECT * FROM evacuations ORDER BY id DESC');
    if (q) {
      const filtered = rows.filter((r) =>
        matchesMedicalSearch(
          [
            r.matricule,
            r.type_patient,
            r.num_carte_etudiant,
            r.prenoms,
            r.nom,
            r.contact,
            r.service_agent_adresse,
            r.motif,
            r.service,
            r.medecin,
            r.structure_evacuation,
            r.statut_evacuation,
            r.infos_en_cours,
            r.issue_evacuation,
            r.user_nom,
          ],
          q
        )
      );
      return res.json(filtered);
    }
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/evacuations', async (req, res) => {
  try {
    const {
      type_patient = 'Etudiant',
      num_carte_etudiant,
      prenoms,
      nom,
      contact,
      service_agent_adresse,
      motif,
      service,
      medecin,
      structure_evacuation,
      date_heure,
      statut_evacuation = 'Ouverte',
      date_heure_fermeture = null,
      infos_en_cours = null,
      issue_evacuation = null,
      user_id,
      user_nom,
    } = req.body;

    if (!num_carte_etudiant || !prenoms || !nom || !motif || !medecin || !structure_evacuation || !date_heure) {
      return res.status(400).json({ error: "Veuillez remplir tous les champs obligatoires de l'évacuation." });
    }

    const autoMatricule = await getNextEvacuationMatricule();
    const cleanType = ['Etudiant', 'Agent', 'Externe'].includes(type_patient) ? type_patient : 'Etudiant';
    const cleanExtra =
      cleanType === 'Etudiant'
        ? null
        : service_agent_adresse
          ? String(service_agent_adresse).trim()
          : null;
    const cleanStatut = statut_evacuation === 'Fermée' ? 'Fermée' : 'Ouverte';

    const result = await query(
      `INSERT INTO evacuations
      (matricule, type_patient, num_carte_etudiant, prenoms, nom, contact, service_agent_adresse, motif, service, medecin, structure_evacuation, date_heure, statut_evacuation, date_heure_fermeture, infos_en_cours, issue_evacuation, user_id, user_nom)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        autoMatricule,
        cleanType,
        formatCarteOrCin(num_carte_etudiant),
        formatPrenoms(prenoms),
        formatNom(nom),
        contact ? formatContact(contact) || null : null,
        cleanExtra,
        motif.trim(),
        service ? service.trim() : 'Urgence',
        medecin.trim(),
        structure_evacuation.trim(),
        date_heure,
        cleanStatut,
        cleanStatut === 'Fermée' ? date_heure_fermeture : null,
        infos_en_cours ? String(infos_en_cours).trim() : null,
        cleanStatut === 'Fermée' && issue_evacuation ? String(issue_evacuation).trim() : null,
        user_id || null,
        user_nom || 'Utilisateur',
      ]
    );

    const created = await query('SELECT * FROM evacuations WHERE id = ?', [result.insertId]);
    res.status(201).json(created[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/evacuations/:id/suivi', async (req, res) => {
  try {
    const existingRows = await query('SELECT * FROM evacuations WHERE id = ?', [req.params.id]);
    if (existingRows.length === 0) {
      return res.status(404).json({ error: 'Évacuation introuvable.' });
    }
    const {
      statut_evacuation,
      date_heure_fermeture,
      infos_en_cours,
      issue_evacuation,
      structure_evacuation,
    } = req.body;

    const current = existingRows[0];
    const nextStatut = statut_evacuation === 'Fermée' ? 'Fermée' : 'Ouverte';
    const nextStructure = structure_evacuation
      ? String(structure_evacuation).trim()
      : current.structure_evacuation;

    await query(
      `UPDATE evacuations SET
        statut_evacuation = ?,
        date_heure_fermeture = ?,
        infos_en_cours = ?,
        issue_evacuation = ?,
        structure_evacuation = ?
       WHERE id = ?`,
      [
        nextStatut,
        nextStatut === 'Fermée' ? date_heure_fermeture || new Date().toISOString().slice(0, 16).replace('T', ' ') : null,
        infos_en_cours !== undefined ? (infos_en_cours ? String(infos_en_cours).trim() : null) : current.infos_en_cours,
        nextStatut === 'Fermée' ? (issue_evacuation ? String(issue_evacuation).trim() : 'Patient déposé / Pris en charge') : null,
        nextStructure,
        req.params.id,
      ]
    );

    const updated = await query('SELECT * FROM evacuations WHERE id = ?', [req.params.id]);
    res.json(updated[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/evacuations/:id', async (req, res) => {
  try {
    const existingRows = await query('SELECT * FROM evacuations WHERE id = ?', [req.params.id]);
    if (existingRows.length === 0) {
      return res.status(404).json({ error: 'Évacuation introuvable.' });
    }

    const {
      type_patient = 'Etudiant',
      num_carte_etudiant,
      prenoms,
      nom,
      contact,
      service_agent_adresse,
      motif,
      service,
      medecin,
      structure_evacuation,
      date_heure,
      statut_evacuation,
      date_heure_fermeture,
      infos_en_cours,
      issue_evacuation,
      request_user_id,
      request_user_role,
      request_user_login,
    } = req.body;

    if (!canModifyRecord(existingRows[0], request_user_id, request_user_role, request_user_login)) {
      return res.status(403).json({
        error: 'Accès refusé : vous ne pouvez modifier que les évacuations que vous avez enregistrées.',
      });
    }

    const cleanType = ['Etudiant', 'Agent', 'Externe'].includes(type_patient) ? type_patient : 'Etudiant';
    const cleanExtra =
      cleanType === 'Etudiant'
        ? null
        : service_agent_adresse
          ? String(service_agent_adresse).trim()
          : null;
    const nextStatut = statut_evacuation
      ? statut_evacuation === 'Fermée'
        ? 'Fermée'
        : 'Ouverte'
      : existingRows[0].statut_evacuation || 'Ouverte';

    await query(
      `UPDATE evacuations SET
        type_patient = ?, num_carte_etudiant = ?, prenoms = ?, nom = ?, contact = ?, service_agent_adresse = ?, motif = ?,
        service = ?, medecin = ?, structure_evacuation = ?, date_heure = ?,
        statut_evacuation = ?, date_heure_fermeture = ?, infos_en_cours = ?, issue_evacuation = ?
       WHERE id = ?`,
      [
        cleanType,
        formatCarteOrCin(num_carte_etudiant),
        formatPrenoms(prenoms),
        formatNom(nom),
        contact ? formatContact(contact) || null : null,
        cleanExtra,
        motif,
        service || 'Urgence',
        medecin,
        structure_evacuation,
        date_heure,
        nextStatut,
        nextStatut === 'Fermée' ? date_heure_fermeture || existingRows[0].date_heure_fermeture : null,
        infos_en_cours !== undefined ? (infos_en_cours ? String(infos_en_cours).trim() : null) : existingRows[0].infos_en_cours,
        nextStatut === 'Fermée' ? (issue_evacuation || existingRows[0].issue_evacuation) : null,
        req.params.id,
      ]
    );

    const updated = await query('SELECT * FROM evacuations WHERE id = ?', [req.params.id]);
    res.json(updated[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/evacuations/:id', async (req, res) => {
  try {
    const existingRows = await query('SELECT * FROM evacuations WHERE id = ?', [req.params.id]);
    if (existingRows.length === 0) {
      return res.status(404).json({ error: 'Évacuation introuvable.' });
    }
    const { userId, role, login } = req.query;
    if (!canModifyRecord(existingRows[0], userId, role, login)) {
      return res.status(403).json({
        error: 'Accès refusé : vous ne pouvez supprimer que vos propres évacuations.',
      });
    }

    await query('DELETE FROM evacuations WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// 6. ÉVACUATIONS SPÉCIALES
// ============================================================================

app.get('/api/evacuations-speciales/next-matricule', async (req, res) => {
  try {
    const matricule = await getNextEvacuationSpecialeMatricule();
    res.json({ matricule });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/evacuations-speciales', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const rows = await query('SELECT * FROM evacuations_speciales ORDER BY id DESC');
    if (q) {
      const filtered = rows.filter((r) =>
        matchesMedicalSearch(
          [
            r.matricule,
            r.type_patient,
            r.num_carte,
            r.prenoms,
            r.nom,
            r.contact,
            r.service_agent_adresse,
            r.service,
            r.motifs,
            r.regulation,
            r.accompagnement_medical,
            r.medecin,
            r.structure,
            r.statut_evacuation,
            r.infos_en_cours,
            r.issue_evacuation,
            r.user_nom,
          ],
          q
        )
      );
      return res.json(filtered);
    }
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/evacuations-speciales', async (req, res) => {
  try {
    const {
      type_patient = 'Etudiant',
      num_carte,
      prenoms,
      nom,
      contact,
      service_agent_adresse,
      service = 'Urgence',
      motifs,
      regulation,
      accompagnement_medical,
      medecin,
      structure,
      date_heure,
      statut_evacuation = 'Ouverte',
      date_heure_fermeture = null,
      infos_en_cours = null,
      issue_evacuation = null,
      user_id,
      user_nom,
    } = req.body;

    if (!num_carte || !prenoms || !nom || !motifs || !medecin || !structure) {
      return res.status(400).json({ error: "Veuillez remplir tous les champs obligatoires de l'évacuation spéciale." });
    }

    const autoMatricule = await getNextEvacuationSpecialeMatricule();
    const nowStr = date_heure || new Date().toISOString().slice(0, 16).replace('T', ' ');
    const cleanType = ['Etudiant', 'Agent', 'Externe'].includes(type_patient) ? type_patient : 'Etudiant';
    const cleanExtra =
      cleanType === 'Etudiant'
        ? null
        : service_agent_adresse
          ? String(service_agent_adresse).trim()
          : null;
    const cleanStatut = statut_evacuation === 'Fermée' ? 'Fermée' : 'Ouverte';

    const result = await query(
      `INSERT INTO evacuations_speciales
      (matricule, type_patient, num_carte, prenoms, nom, contact, service_agent_adresse, service, motifs, regulation, accompagnement_medical, medecin, structure, date_heure, statut_evacuation, date_heure_fermeture, infos_en_cours, issue_evacuation, user_id, user_nom)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        autoMatricule,
        cleanType,
        formatCarteOrCin(num_carte),
        formatPrenoms(prenoms),
        formatNom(nom),
        contact ? formatContact(contact) || null : null,
        cleanExtra,
        service ? String(service).trim() : 'Urgence',
        motifs.trim(),
        regulation === 'Oui' ? 'Oui' : 'Non',
        accompagnement_medical ? accompagnement_medical.trim() : null,
        medecin.trim(),
        structure.trim(),
        nowStr,
        cleanStatut,
        cleanStatut === 'Fermée' ? date_heure_fermeture : null,
        infos_en_cours ? String(infos_en_cours).trim() : null,
        cleanStatut === 'Fermée' && issue_evacuation ? String(issue_evacuation).trim() : null,
        user_id || null,
        user_nom || 'Utilisateur',
      ]
    );

    const created = await query('SELECT * FROM evacuations_speciales WHERE id = ?', [result.insertId]);
    res.status(201).json(created[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/evacuations-speciales/:id/suivi', async (req, res) => {
  try {
    const existingRows = await query('SELECT * FROM evacuations_speciales WHERE id = ?', [
      req.params.id,
    ]);
    if (existingRows.length === 0) {
      return res.status(404).json({ error: 'Évacuation spéciale introuvable.' });
    }
    const {
      statut_evacuation,
      date_heure_fermeture,
      infos_en_cours,
      issue_evacuation,
      structure,
    } = req.body;

    const current = existingRows[0];
    const nextStatut = statut_evacuation === 'Fermée' ? 'Fermée' : 'Ouverte';
    const nextStructure = structure ? String(structure).trim() : current.structure;

    await query(
      `UPDATE evacuations_speciales SET
        statut_evacuation = ?,
        date_heure_fermeture = ?,
        infos_en_cours = ?,
        issue_evacuation = ?,
        structure = ?
       WHERE id = ?`,
      [
        nextStatut,
        nextStatut === 'Fermée' ? date_heure_fermeture || new Date().toISOString().slice(0, 16).replace('T', ' ') : null,
        infos_en_cours !== undefined ? (infos_en_cours ? String(infos_en_cours).trim() : null) : current.infos_en_cours,
        nextStatut === 'Fermée' ? (issue_evacuation ? String(issue_evacuation).trim() : 'Patient déposé / Pris en charge') : null,
        nextStructure,
        req.params.id,
      ]
    );

    const updated = await query('SELECT * FROM evacuations_speciales WHERE id = ?', [req.params.id]);
    res.json(updated[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/evacuations-speciales/:id', async (req, res) => {
  try {
    const existingRows = await query('SELECT * FROM evacuations_speciales WHERE id = ?', [
      req.params.id,
    ]);
    if (existingRows.length === 0) {
      return res.status(404).json({ error: 'Évacuation spéciale introuvable.' });
    }

    const {
      type_patient = 'Etudiant',
      num_carte,
      prenoms,
      nom,
      contact,
      service_agent_adresse,
      service,
      motifs,
      regulation,
      accompagnement_medical,
      medecin,
      structure,
      date_heure,
      statut_evacuation,
      date_heure_fermeture,
      infos_en_cours,
      issue_evacuation,
      request_user_id,
      request_user_role,
      request_user_login,
    } = req.body;

    if (!canModifyRecord(existingRows[0], request_user_id, request_user_role, request_user_login)) {
      return res.status(403).json({
        error: 'Accès refusé : vous ne pouvez modifier que les évacuations spéciales que vous avez enregistrées.',
      });
    }

    const cleanType = ['Etudiant', 'Agent', 'Externe'].includes(type_patient) ? type_patient : 'Etudiant';
    const cleanExtra =
      cleanType === 'Etudiant'
        ? null
        : service_agent_adresse
          ? String(service_agent_adresse).trim()
          : null;
    const nextStatut = statut_evacuation
      ? statut_evacuation === 'Fermée'
        ? 'Fermée'
        : 'Ouverte'
      : existingRows[0].statut_evacuation || 'Ouverte';

    await query(
      `UPDATE evacuations_speciales SET
        type_patient = ?, num_carte = ?, prenoms = ?, nom = ?, contact = ?, service_agent_adresse = ?, service = ?, motifs = ?,
        regulation = ?, accompagnement_medical = ?, medecin = ?, structure = ?, date_heure = ?,
        statut_evacuation = ?, date_heure_fermeture = ?, infos_en_cours = ?, issue_evacuation = ?
       WHERE id = ?`,
      [
        cleanType,
        formatCarteOrCin(num_carte),
        formatPrenoms(prenoms),
        formatNom(nom),
        contact ? formatContact(contact) || null : null,
        cleanExtra,
        service || existingRows[0].service || 'Urgence',
        motifs,
        regulation === 'Oui' ? 'Oui' : 'Non',
        accompagnement_medical || null,
        medecin,
        structure,
        date_heure,
        nextStatut,
        nextStatut === 'Fermée' ? date_heure_fermeture || existingRows[0].date_heure_fermeture : null,
        infos_en_cours !== undefined ? (infos_en_cours ? String(infos_en_cours).trim() : null) : existingRows[0].infos_en_cours,
        nextStatut === 'Fermée' ? (issue_evacuation || existingRows[0].issue_evacuation) : null,
        req.params.id,
      ]
    );

    const updated = await query('SELECT * FROM evacuations_speciales WHERE id = ?', [req.params.id]);
    res.json(updated[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/evacuations-speciales/:id', async (req, res) => {
  try {
    const existingRows = await query('SELECT * FROM evacuations_speciales WHERE id = ?', [
      req.params.id,
    ]);
    if (existingRows.length === 0) {
      return res.status(404).json({ error: 'Évacuation spéciale introuvable.' });
    }
    const { userId, role, login } = req.query;
    if (!canModifyRecord(existingRows[0], userId, role, login)) {
      return res.status(403).json({
        error: 'Accès refusé : vous ne pouvez supprimer que vos propres évacuations spéciales.',
      });
    }

    await query('DELETE FROM evacuations_speciales WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// 5, 7 & 8. MÉDECINS, SERVICES ET ÉQUIPES SECOURS
// ============================================================================

app.get('/api/medecins', async (req, res) => {
  try {
    const rows = await query('SELECT * FROM medecins ORDER BY id DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/medecins', async (req, res) => {
  try {
    const { prenoms, nom, contact } = req.body;
    if (!prenoms || !nom || !contact) {
      return res.status(400).json({ error: 'Prénoms, nom et contact du médecin sont obligatoires.' });
    }
    const result = await query(
      'INSERT INTO medecins (prenoms, nom, contact) VALUES (?, ?, ?)',
      [formatPrenoms(prenoms), formatNom(nom), formatContact(contact)]
    );
    const created = await query('SELECT * FROM medecins WHERE id = ?', [result.insertId]);
    res.status(201).json(created[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/medecins/:id', async (req, res) => {
  try {
    const { prenoms, nom, contact } = req.body;
    if (!prenoms || !nom || !contact) {
      return res.status(400).json({ error: 'Prénoms, nom et contact du médecin sont obligatoires.' });
    }
    await query(
      'UPDATE medecins SET prenoms = ?, nom = ?, contact = ? WHERE id = ?',
      [formatPrenoms(prenoms), formatNom(nom), formatContact(contact), req.params.id]
    );
    const updated = await query('SELECT * FROM medecins WHERE id = ?', [req.params.id]);
    res.json(updated[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/medecins/:id', async (req, res) => {
  try {
    await query('DELETE FROM medecins WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/services', async (req, res) => {
  try {
    const rows = await query('SELECT * FROM services ORDER BY id ASC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/services', async (req, res) => {
  try {
    const { nom_service } = req.body;
    if (!nom_service) {
      return res.status(400).json({ error: 'Le nom du service est obligatoire.' });
    }
    const existing = await query('SELECT id FROM services WHERE nom_service = ?', [nom_service.trim()]);
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Ce service existe déjà.' });
    }
    const result = await query('INSERT INTO services (nom_service) VALUES (?)', [nom_service.trim()]);
    const created = await query('SELECT * FROM services WHERE id = ?', [result.insertId]);
    res.status(201).json(created[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/services/:id', async (req, res) => {
  try {
    const { nom_service } = req.body;
    if (!nom_service) {
      return res.status(400).json({ error: 'Le nom du service est obligatoire.' });
    }
    const existing = await query('SELECT id FROM services WHERE nom_service = ? AND id != ?', [
      nom_service.trim(),
      req.params.id,
    ]);
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Ce nom de service existe déjà.' });
    }
    await query('UPDATE services SET nom_service = ? WHERE id = ?', [
      nom_service.trim(),
      req.params.id,
    ]);
    const updated = await query('SELECT * FROM services WHERE id = ?', [req.params.id]);
    res.json(updated[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/services/:id', async (req, res) => {
  try {
    await query('DELETE FROM services WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/equipes-secours', async (req, res) => {
  try {
    const rows = await query('SELECT * FROM equipes_secours ORDER BY id ASC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/equipes-secours', async (req, res) => {
  try {
    const { libelle, chef_equipe } = req.body;
    if (!libelle || !chef_equipe) {
      return res.status(400).json({ error: "Le libellé et le chef d'équipe sont obligatoires." });
    }
    const existing = await query('SELECT id FROM equipes_secours WHERE libelle = ?', [
      libelle.trim(),
    ]);
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Cette équipe existe déjà.' });
    }
    const result = await query(
      'INSERT INTO equipes_secours (libelle, chef_equipe) VALUES (?, ?)',
      [libelle.trim(), chef_equipe.trim()]
    );
    const created = await query('SELECT * FROM equipes_secours WHERE id = ?', [result.insertId]);
    res.status(201).json(created[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/equipes-secours/:id', async (req, res) => {
  try {
    const { libelle, chef_equipe } = req.body;
    if (!libelle || !chef_equipe) {
      return res.status(400).json({ error: "Le libellé et le chef d'équipe sont obligatoires." });
    }
    const existing = await query(
      'SELECT id FROM equipes_secours WHERE libelle = ? AND id != ?',
      [libelle.trim(), req.params.id]
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: "Ce libellé d'équipe existe déjà." });
    }
    await query('UPDATE equipes_secours SET libelle = ?, chef_equipe = ? WHERE id = ?', [
      libelle.trim(),
      chef_equipe.trim(),
      req.params.id,
    ]);
    const updated = await query('SELECT * FROM equipes_secours WHERE id = ?', [req.params.id]);
    res.json(updated[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/equipes-secours/:id', async (req, res) => {
  try {
    await query('DELETE FROM equipes_secours WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// RAPPORTS CONNECTÉS À LA DB
// ============================================================================

app.get('/api/rapports', async (req, res) => {
  try {
    const {
      periodType = 'all',
      date,
      month,
      startDate,
      endDate,
      q = '',
      symptome = '',
      typePatient = 'all',
    } = req.query;

    let fromStr = '0000-01-01';
    let toStr = '9999-12-31';

    if (periodType === 'day' && date) {
      fromStr = date;
      toStr = date;
    } else if (periodType === 'month' && month) {
      fromStr = `${month}-01`;
      toStr = `${month}-31`;
    } else if (periodType === 'range') {
      if (startDate) fromStr = startDate;
      if (endDate) toStr = endDate;
    }

    const search = String(q || '').trim();
    const symptomeFilter = String(symptome || '').trim();
    const patientCatFilter = String(typePatient || 'all').trim();

    const matchesPatientCategory = (row) => {
      if (!patientCatFilter || patientCatFilter === 'all') return true;
      const rowType = row.type_patient || 'Etudiant';
      return rowType.toLowerCase() === patientCatFilter.toLowerCase();
    };

    const rawInterventions = await query(
      `SELECT * FROM interventions
       WHERE SUBSTR(COALESCE(CAST(date_heure_intervention AS TEXT), CAST(created_at AS TEXT)), 1, 10) >= ?
         AND SUBSTR(COALESCE(CAST(date_heure_intervention AS TEXT), CAST(created_at AS TEXT)), 1, 10) <= ?
       ORDER BY date_heure_intervention DESC, id DESC`,
      [fromStr, toStr]
    );

    const rawEvacuations = await query(
      `SELECT * FROM evacuations
       WHERE SUBSTR(COALESCE(CAST(date_heure AS TEXT), CAST(created_at AS TEXT)), 1, 10) >= ?
         AND SUBSTR(COALESCE(CAST(date_heure AS TEXT), CAST(created_at AS TEXT)), 1, 10) <= ?
       ORDER BY date_heure DESC, id DESC`,
      [fromStr, toStr]
    );

    const rawEvacSpec = await query(
      `SELECT * FROM evacuations_speciales
       WHERE SUBSTR(COALESCE(CAST(date_heure AS TEXT), CAST(created_at AS TEXT)), 1, 10) >= ?
         AND SUBSTR(COALESCE(CAST(date_heure AS TEXT), CAST(created_at AS TEXT)), 1, 10) <= ?
       ORDER BY date_heure DESC, id DESC`,
      [fromStr, toStr]
    );

    const interventions = rawInterventions.filter((r) => {
      if (!matchesPatientCategory(r)) return false;
      const okSearch =
        !search ||
        matchesMedicalSearch(
          [
            r.matricule,
            r.type_patient,
            r.num_carte_etudiant,
            r.prenoms,
            r.nom,
            r.service_agent_adresse,
            r.plaintes,
            r.agent_en_charge,
          ],
          search
        );
      const okSymp = !symptomeFilter || matchesMedicalSearch([r.plaintes], symptomeFilter);
      return okSearch && okSymp;
    });

    const evacuations = rawEvacuations.filter((r) => {
      if (!matchesPatientCategory(r)) return false;
      const okSearch =
        !search ||
        matchesMedicalSearch(
          [
            r.matricule,
            r.type_patient,
            r.num_carte_etudiant,
            r.prenoms,
            r.nom,
            r.service_agent_adresse,
            r.motif,
            r.service,
            r.structure_evacuation,
            r.medecin,
          ],
          search
        );
      const okSymp = !symptomeFilter || matchesMedicalSearch([r.motif], symptomeFilter);
      return okSearch && okSymp;
    });

    const evacuations_speciales = rawEvacSpec.filter((r) => {
      if (!matchesPatientCategory(r)) return false;
      const okSearch =
        !search ||
        matchesMedicalSearch(
          [
            r.matricule,
            r.type_patient,
            r.num_carte,
            r.prenoms,
            r.nom,
            r.service_agent_adresse,
            r.motifs,
            r.structure,
            r.medecin,
            r.regulation,
          ],
          search
        );
      const okSymp = !symptomeFilter || matchesMedicalSearch([r.motifs], symptomeFilter);
      return okSearch && okSymp;
    });

    // Construction de la synthèse statistique par Symptômes / Plaintes
    const groupMap = new Map();
    const ensureCategory = (cat) => {
      if (!groupMap.has(cat)) {
        groupMap.set(cat, {
          categorie: cat,
          nb_interventions: 0,
          nb_evacuations: 0,
          nb_evacuations_speciales: 0,
          total_cas: 0,
          patientsSet: new Set(),
          exemples: new Set(),
        });
      }
      return groupMap.get(cat);
    };

    for (const item of interventions) {
      const cat = classifySymptomCategory(item.plaintes);
      const entry = ensureCategory(cat);
      entry.nb_interventions += 1;
      entry.total_cas += 1;
      if (item.num_carte_etudiant) entry.patientsSet.add(String(item.num_carte_etudiant).trim());
      if (item.plaintes && entry.exemples.size < 3) entry.exemples.add(item.plaintes);
    }

    for (const item of evacuations) {
      const cat = classifySymptomCategory(item.motif);
      const entry = ensureCategory(cat);
      entry.nb_evacuations += 1;
      entry.total_cas += 1;
      if (item.num_carte_etudiant) entry.patientsSet.add(String(item.num_carte_etudiant).trim());
      if (item.motif && entry.exemples.size < 3) entry.exemples.add(item.motif);
    }

    for (const item of evacuations_speciales) {
      const cat = classifySymptomCategory(item.motifs);
      const entry = ensureCategory(cat);
      entry.nb_evacuations_speciales += 1;
      entry.total_cas += 1;
      if (item.num_carte) entry.patientsSet.add(String(item.num_carte).trim());
      if (item.motifs && entry.exemples.size < 3) entry.exemples.add(item.motifs);
    }

    const symptomes_rapport = Array.from(groupMap.values())
      .map((g) => ({
        categorie: g.categorie,
        nb_interventions: g.nb_interventions,
        nb_evacuations: g.nb_evacuations,
        nb_evacuations_speciales: g.nb_evacuations_speciales,
        total_cas: g.total_cas,
        nb_patients: g.patientsSet.size,
        exemples: Array.from(g.exemples),
      }))
      .sort((a, b) => b.total_cas - a.total_cas);

    res.json({
      interventions,
      evacuations,
      evacuations_speciales,
      symptomes_rapport,
      meta: { periodType, fromStr, toStr, symptome: symptomeFilter },
      db: getDbStatus(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// STATISTIQUES DU TABLEAU DE BORD
// ============================================================================

app.get('/api/stats', async (req, res) => {
  try {
    const [intCount] = await query('SELECT COUNT(*) as total FROM interventions');
    const [evacCount] = await query('SELECT COUNT(*) as total FROM evacuations');
    const [evacSpecCount] = await query('SELECT COUNT(*) as total FROM evacuations_speciales');
    const [medCount] = await query('SELECT COUNT(*) as total FROM medecins');
    const [srvCount] = await query('SELECT COUNT(*) as total FROM services');
    const [eqCount] = await query('SELECT COUNT(*) as total FROM equipes_secours');
    const [usrCount] = await query('SELECT COUNT(*) as total FROM users');

    const recentInterventions = await query('SELECT * FROM interventions ORDER BY id DESC');
    const recentEvacuations = await query('SELECT * FROM evacuations ORDER BY id DESC');
    const recentEvacSpec = await query('SELECT * FROM evacuations_speciales ORDER BY id DESC');

    res.json({
      counts: {
        interventions: Number(intCount.total),
        evacuations: Number(evacCount.total),
        evacuations_speciales: Number(evacSpecCount.total),
        medecins: Number(medCount.total),
        services: Number(srvCount.total),
        equipes_secours: Number(eqCount.total),
        users: Number(usrCount.total),
      },
      recent: {
        interventions: recentInterventions,
        evacuations: recentEvacuations,
        evacuations_speciales: recentEvacSpec,
      },
      db: getDbStatus(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const distPath = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));

  // Servir l'application sur la racine (pour l'hébergement en ligne) et sur l'URL chiffrée confidentielle
  app.get('/', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });

  app.get(SECRET_PATH, (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });

  app.get(`${SECRET_PATH}/*`, (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });

  app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) {
      return res.status(404).json({ error: 'Route API introuvable' });
    }
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

initDatabase().then(() => {
  // 1. Écoute sur le port chiffré confidentiel (58492) en IPv4 et IPv6
  const serverSecret = app.listen(SECRET_PORT, '0.0.0.0', () => {
    console.log(
      `[Serveur COUD - URL Chiffrée Principale] http://${SECRET_SUBDOMAIN}:${SECRET_PORT}${SECRET_PATH}`
    );
  });
  serverSecret.on('error', () => { });

  // 2. Écoute spécifique sur 127.0.0.1:80 (prioritaire sur 0.0.0.0:80 d'Apache XAMPP sous Windows)
  const server80v4 = app.listen(80, '127.0.0.1', () => {
    console.log(
      `[Serveur COUD - Port 80 IPv4] http://${SECRET_SUBDOMAIN}${SECRET_PATH}`
    );
  });
  server80v4.on('error', () => { });

  // 3. Maintien du port 3001 en secours
  const serverMain = app.listen(PORT, '0.0.0.0', () => {
    console.log(
      `[Serveur COUD - Principal] http://127.0.0.1:${PORT}${SECRET_PATH}`
    );
  });
  serverMain.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[Serveur COUD] Le port ${PORT} est déjà occupé par une instance existante.`);
    } else {
      console.error(`[Serveur COUD] Erreur serveur :`, err.message);
    }
  });
});
