process.env.DISABLE_TELEGRAM = 'true';
process.env.DASHBOARD_PORT = process.env.DASHBOARD_PORT || '3141';
process.env.DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || 'earlyaidopters';

require('./index.js');
