const axios = require('axios');
const { log } = require('./utils');

const NOTIFICATION_WEBHOOK = process.env.NOTIFICATION_WEBHOOK || '';

async function sendAllAccountsFailedNotification(attempts) {
  const message = {
    level: 'error',
    title: 'Ollama Multi Router: All Accounts Failed',
    message: 'All configured Ollama accounts failed to serve the latest request.',
    timestamp: new Date().toISOString(),
    attempts
  };

  log('error', message.title, message);

  if (!NOTIFICATION_WEBHOOK) {
    return { sent: false, reason: 'No notification webhook configured' };
  }

  try {
    await axios.post(NOTIFICATION_WEBHOOK, message, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    });
    log('info', 'Notification webhook sent successfully');
    return { sent: true };
  } catch (err) {
    log('error', 'Failed to send notification webhook', err.message);
    return { sent: false, error: err.message };
  }
}

module.exports = {
  sendAllAccountsFailedNotification
};
