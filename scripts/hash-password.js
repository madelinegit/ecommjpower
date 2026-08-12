// Generates the bcrypt hash for ADMIN_PASSWORD_HASH.
//
//   npm run hash-password "the-password"
//
// Paste the output into Railway > Variables. The plain password is never
// stored anywhere — only this hash.

const bcrypt = require('bcryptjs');

const password = process.argv[2];

if (!password) {
  console.error('Usage: npm run hash-password "your-password-here"');
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 12);

console.log('\nADMIN_PASSWORD_HASH=' + hash + '\n');
