# Conciliación Cultura UNO

Sistema contable para procesar y continuar trabajando expedientes de conciliación.

## Archivos de entrada

1. **Archivo 1: Entrada UNO**  
   Documento principal. Se conserva completo.

2. **Archivo 2: Pago UNO**  
   Documento complementario. Se incorporan las columnas marcadas como `Sumar` y se cruza por:

   `Entrada UNO.Orden# = Pago UNO.ID de Operación`

3. **Archivo 3: Pagos QR por fecha**  
   Archivo opcional para completar el unificado de tres fuentes. Se incorporan **solo las columnas amarillas**:

   - id Operacion
   - Confirmada
   - Devuelta
   - FechaDeCompra
   - FechaDePago
   - Cliente
   - DNI
   - Billetera
   - Bruto
   - Descuento
   - Neto
   - Status
   - devo_voucher_type
   - devo_voucher_code
   - devo_voucher_datetime

   Cruce aplicado:

   `Entrada UNO.Orden# = Pagos QR.id Operacion`

## Puertos

- Frontend Vite: `http://localhost:5178`
- Backend API: `http://localhost:4108`
- PostgreSQL: `localhost:5441`

## Usuario inicial

- Usuario: `admin@conciliacion.local`
- Contraseña: `Admin1234`

## Ejecución

```powershell
npm config set registry https://registry.npmjs.org/
npm install
Copy-Item .env.example .env -Force
docker compose up -d
npm run db:init
npm run dev
```

## Flujo

1. Login obligatorio.
2. Cargar Archivo 1, Archivo 2 y opcionalmente Archivo 3 QR.
3. Procesar y guardar Paso 1.
4. Abrir el expediente guardado.
5. Ver el **Archivo unificado completo**.
6. Trabajar filtros, paneles, gráficos y conciliación manual.
7. Exportar Excel completo con filtros.

## Cambio operativo aplicado

Después de procesar el Paso 1, el sistema muestra el archivo unificado completo directamente dentro de **Expediente de conciliación**, debajo de las tarjetas de resumen. Se eliminó la pestaña separada "Archivo unificado completo" y se desactivó la conciliación manual por fila por ahora.

El archivo unificado contiene:

- Todas las columnas originales de Entrada UNO.
- Columnas agregadas desde Pago UNO.
- Columnas amarillas del archivo QR.
- Campos contables calculados y de control.

La grilla está paginada para rendimiento, pero el expediente conserva todos los datos en PostgreSQL y la exportación genera el Excel completo.


## Reglas contables vigentes

- **Provincia 100%**: se toma de la columna `Precio Final S/Interés` del archivo Entrada UNO.
- **Entrada UNO 10%**: se toma de la columna `Valor SCH` del archivo Entrada UNO.
- **Total Venta 110%**: se calcula como `Provincia 100% + Entrada UNO 10%`.
- En **Tabla Operaciones Pagadas**, las sumas se hacen solo sobre filas con `Estado = Pagada`.
