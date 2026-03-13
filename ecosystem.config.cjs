// PM2 process config — used on the VPS to keep the bot always-on.
// Usage: pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name:         'second-brain',
      script:       'bot.mjs',
      interpreter:  'node',
      watch:        false,
      autorestart:  true,
      max_restarts: 10,
      restart_delay: 5000,
      env: {
        NODE_ENV: 'production',
      },
      error_file: 'logs/pm2-error.log',
      out_file:   'logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
