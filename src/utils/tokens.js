const jwt = require('jsonwebtoken');

function signUnsubscribeToken(userId) {
  return jwt.sign(
    { sub: userId, purpose: 'digest_unsubscribe' },
    process.env.JWT_SECRET,
    { expiresIn: process.env.UNSUBSCRIBE_TOKEN_EXPIRES_IN || '180d' }
  );
}

function verifyUnsubscribeToken(token) {
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  if (decoded.purpose !== 'digest_unsubscribe' || !decoded.sub) {
    throw new Error('Invalid unsubscribe token');
  }
  return decoded.sub;
}

module.exports = { signUnsubscribeToken, verifyUnsubscribeToken };
