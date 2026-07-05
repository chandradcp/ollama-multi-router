const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { log } = require('./utils');

// File persisten untuk menyimpan daftar klien (Tenant)
const CLIENTS_FILE = process.env.CLIENTS_CONFIG_PATH || path.join(__dirname, '..', 'config', 'clients.json');

let clients = [];

// Fallback seed untuk klien bawaan jika file tidak ada
const DEFAULT_CLIENT = {
  id: 'client-default',
  name: 'Default Client',
  key: 'sk-local-router-change-me',
  enabled: true,
  createdAt: Date.now()
};

function ensureConfigDir() {
  const dir = path.dirname(CLIENTS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadClients() {
  try {
    ensureConfigDir();
    if (fs.existsSync(CLIENTS_FILE)) {
      const data = fs.readFileSync(CLIENTS_FILE, 'utf8');
      const parsed = JSON.parse(data);
      clients = Array.isArray(parsed) ? parsed : [];
    } else {
      // Buat file default jika belum ada
      clients = [DEFAULT_CLIENT];
      saveClientsToFile();
    }
    
    // Migrasi jika gateway.json (dari legacy) ada dan kita mau merge? 
    // Untuk saat ini kita abaikan migrasi otomatis gateway.json agar sederhana.

    log('info', `Loaded ${clients.length} API clients from config`);
  } catch (err) {
    log('error', 'Failed to load clients config', err.message);
    clients = [DEFAULT_CLIENT];
  }
}

function saveClientsToFile() {
  try {
    ensureConfigDir();
    fs.writeFileSync(CLIENTS_FILE, JSON.stringify(clients, null, 2), 'utf8');
  } catch (err) {
    log('error', 'Failed to save clients config', err.message);
  }
}

function getClients() {
  return clients;
}

// Generate secure random API key
function generateKey() {
  return 'sk-router-' + crypto.randomBytes(24).toString('hex');
}

function addClient(name) {
  const newClient = {
    id: `client-${Date.now()}`,
    name: name || 'New Client',
    key: generateKey(),
    enabled: true,
    createdAt: Date.now()
  };
  clients.push(newClient);
  saveClientsToFile();
  log('info', `Added new client: ${newClient.name}`);
  return newClient;
}

function toggleClient(id) {
  const client = clients.find(c => c.id === id);
  if (client) {
    client.enabled = !client.enabled;
    saveClientsToFile();
    log('info', `Client ${client.name} is now ${client.enabled ? 'enabled' : 'disabled'}`);
    return { success: true, enabled: client.enabled };
  }
  return { success: false, error: 'Client not found' };
}

function deleteClient(id) {
  const initialLength = clients.length;
  clients = clients.filter(c => c.id !== id);
  if (clients.length < initialLength) {
    saveClientsToFile();
    log('info', `Deleted client ${id}`);
    return { success: true };
  }
  return { success: false, error: 'Client not found' };
}

// Validasi token yang masuk dari request (Authentication)
function isValidClient(token) {
  if (!token) return false;
  // Cari di array klien yang cocok dan aktif
  const client = clients.find(c => c.key === token && c.enabled);
  return !!client;
}

// Mendapatkan nama klien berdasarkan token (untuk keperluan logs)
function getClientName(token) {
  const client = clients.find(c => c.key === token);
  return client ? client.name : 'Unknown';
}

module.exports = {
  loadClients,
  getClients,
  addClient,
  toggleClient,
  deleteClient,
  isValidClient,
  getClientName
};
