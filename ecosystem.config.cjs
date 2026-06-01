module.exports = {
  apps: [
    {
      name: 'discord-music',
      script: 'server/index.js',
      interpreter: 'node',
      interpreter_args: '--experimental-vm-modules',

      // Restart policy
      autorestart: true,
      max_restarts: 20,
      min_uptime: '10s',         // must stay up 10s to count as a successful start
      restart_delay: 2000,       // 2s cooldown between restarts

      // Memory guard — restart if the process leaks past 512 MB
      max_memory_restart: '512M',

      // Environment
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
      },

      // Logging
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,

      // Graceful shutdown — give Socket.IO time to drain connections
      kill_timeout: 5000,
      listen_timeout: 10000,

      // Cron-based daily restart at 4 AM to clear any slow memory leaks
      cron_restart: '0 4 * * *',
    },
  ],
};
