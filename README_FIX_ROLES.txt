Corrección aplicada: roles, permisos y acceso por permisos

Cambios principales:
- /api/auth/login y /api/auth/me devuelven permissions del rol.
- Las tarjetas del sistema ya no dependen solo de user.role === ADMIN.
- OPERADOR o LECTOR ven las pantallas según role_permissions.
- /api/runs y /api/runs/:id permiten abrir expedientes si el rol tiene OPEN_RUNS.
- /api/roles devuelve permisos canónicos, sin duplicados aunque la tabla vieja tenga filas repetidas.
- database.sql limpia duplicados históricos e inicializa role_permission_catalog, role_permissions y user_audit_logs.
- src/App.tsx filtra permisos duplicados como segunda protección.

Aplicación:
1) Ctrl + C
2) Reemplazar proyecto con este contenido.
3) npm install
4) docker compose up -d
5) npm run db:init
6) npm run dev
7) Ctrl + F5 en navegador

Importante:
- Después de modificar permisos de un rol, cerrar sesión y volver a iniciar sesión con ese usuario.
- Los permisos se cargan al iniciar sesión.
