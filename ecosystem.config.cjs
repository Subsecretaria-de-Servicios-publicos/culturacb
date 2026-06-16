module.exports = {
  apps: [
    {
      name: "culturacb-api",
      script: "node_modules/.bin/tsx",
      args: "server/index.ts",
      node_args: "--max-old-space-size=4096",
      cwd: "/home/userdes/culturacb",
      interpreter: "none",
      env: {
        NODE_ENV: "production",
        NODE_OPTIONS: "--max-old-space-size=4096",
        // JWT_SECRET: "generá un valor aleatorio seguro, ej: openssl rand -hex 48"
        // Podés definirlo aquí o en el .env del servidor; el proceso falla si no está seteado.
      },
      restart_delay: 3000,
      max_restarts: 10,
    },
  ],
};
