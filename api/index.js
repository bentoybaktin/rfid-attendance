const { app, appReady } = require('../server');

module.exports = async (req, res) => {
  await appReady;
  return app(req, res);
};
