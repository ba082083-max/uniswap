// pm2 start ecosystem.config.cjs で起動
module.exports = {
  apps: [
    {
      name: 'lp-bot',
      script: 'src/index.js',
      node_args: '--env-file=.env',
      autorestart: true,
      restart_delay: 10000,
      max_memory_restart: '300M',
    },
  ],
};
