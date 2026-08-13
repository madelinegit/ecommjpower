// Helpers shared by the page templates.

const PHONE_DIGITS = '7723418850';

// Bullet points are stored one per line, so blank lines and stray spaces
// from a phone keyboard get dropped rather than rendering empty bullets.
function bullets(features) {
  return (features || '')
    .split(/\r?\n/)
    .map(b => b.trim())
    .filter(Boolean);
}

function slug(title) {
  return (title || 'piece')
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'piece';
}

// Prefilled message referencing the specific item, so an enquiry arrives with
// context instead of "hi".
function messageFor(item) {
  return item.category === 'home'
    ? `Hi James, I saw "${item.title}" on your site and I'd like a quote for something similar.`
    : `Hi James, I'm interested in "${item.title}" from your site. Is it available?`;
}

// sms: needs "?&body=" to prefill on both iOS and Android.
function smsLink(item) {
  return `sms:${PHONE_DIGITS}?&body=${encodeURIComponent(messageFor(item))}`;
}

function mailLink(item) {
  const subject = item.category === 'home'
    ? `Quote request: ${item.title}`
    : `Question about ${item.title}`;
  return `mailto:jpowertahoe@aol.com?subject=${encodeURIComponent(subject)}` +
         `&body=${encodeURIComponent(messageFor(item))}`;
}

function metaDescriptionFor(item) {
  if (item.description) return item.description.replace(/\s+/g, ' ').slice(0, 300);
  return item.category === 'home'
    ? `${item.title} by Power Creations LLC — home repairs and projects in North Lake Tahoe and Truckee, CA. Call 772-341-8850.`
    : `${item.title} — handcrafted by James Power in North Lake Tahoe. Made in Tahoe, shipped anywhere. Call 772-341-8850.`;
}

module.exports = { slug, bullets, smsLink, mailLink, messageFor, metaDescriptionFor, PHONE_DIGITS };
