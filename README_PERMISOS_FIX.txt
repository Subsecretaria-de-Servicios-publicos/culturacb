Corrección aplicada: permisos reales por rol

Cambios:
- El backend ahora evalúa permisos desde role_permissions, no solamente user.role === ADMIN.
- Un OPERADOR con permisos de administrador puede ver y usar las pantallas correspondientes.
- /api/auth/login y /api/auth/me devuelven permissions en la sesión.
- Las tarjetas/pantallas del frontend se muestran según permisos.
- Usuarios y roles ya no depende únicamente del rol ADMIN, sino de MANAGE_USERS / MANAGE_ROLES / VIEW_USER_AUDIT.
- El historial de conciliaciones permite ver todos los expedientes a roles con permisos administrativos.
- Corrección de src/api.ts para que el build compile.

Aplicación:
1) Descomprimir reemplazando el proyecto actual.
2) Ejecutar:
   npm install
   docker compose up -d
   npm run db:init
   npm run dev
3) Cerrar sesión y volver a iniciar sesión con el usuario OPERADOR, para que tome los permisos actualizados.
