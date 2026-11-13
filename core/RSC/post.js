function handlePost(req, res, handler) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  return handler(req, res);
}

module.exports = { handlePost };
