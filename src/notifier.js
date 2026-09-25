// OS notification — the closing moment of the loop. Fires a native macOS
// notification directly on the laptop. No Freshservice notification/email
// code involved; this is the Tally tool telling you, not Freshservice.

const { execSync } = require('child_process');

function notifyMac(title, message) {
  const escape = (s) => String(s).replace(/"/g, '\\"');
  const script = `display notification "${escape(message)}" with title "${escape(title)}" sound name "Glass"`;
  try {
    execSync(`osascript -e '${script}'`);
    return true;
  } catch (err) {
    console.error('[notifier] failed to fire OS notification:', err.message);
    return false;
  }
}

function notifyResolved({ ticketDisplayId, cause, fix }) {
  const title = 'Tally';
  const message = `Ticket #${ticketDisplayId} resolved — ${cause}. Fix applied: ${fix}`;

  if (process.platform === 'darwin') {
    return notifyMac(title, message);
  }

  // Non-macOS fallback so the loop is still visible during sandboxed/dev runs.
  console.log(`\n🔔 [${title}] ${message}\n`);
  return true;
}

module.exports = { notifyResolved, notifyMac };
