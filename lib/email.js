const https = require('https');

/**
 * Send an email via Resend API.
 * Swap this function body for SendGrid/SES if needed — same interface.
 *
 * @param {Object} opts
 * @param {string} opts.to - Recipient email
 * @param {string} opts.subject - Email subject
 * @param {string} opts.html - HTML body
 * @returns {Promise<Object>} Resend API response
 */
function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return Promise.reject(new Error('RESEND_API_KEY not set'));
  }

  const from = process.env.EMAIL_FROM || 'MeetingMind <onboarding@resend.dev>';
  const body = JSON.stringify({ from, to: [to], subject, html });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); }
          catch { resolve({ ok: true }); }
        } else {
          reject(new Error(`Email API ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = { sendEmail };
