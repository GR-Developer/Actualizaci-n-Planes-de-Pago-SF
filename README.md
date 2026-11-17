Este servicio corre localmente en un servidor nodeJS.

Tiene 2 funcionalidades:

1. Crear pagos masivamente tomando en cuenta la fecha de inicio y fin de contrato que tiene la oportunidad: http://localhost:3000/api/salesforce/assets/generarPagos
   - Para ello el plan de pago como mínimo debe de tener un pago y ese se replicará hasta la fecha de fin de contrato solo cambiando la fecha.
     
2. Crear abonos dentro de los pagos para que pasen de estar pendiente a estar en cerrado: http://localhost:3000/api/salesforce/assets/cerrarPagos
  - En este caso se deberá de crear el último abono hasta donde se quiere que se rellenen los demás y el programa pasará los demás a cerrado creando los abonos.


     Ambos endpoint utilizan este flujo de datos:
{
  "assetIds": [
     "02iTN000000K4R9YAK"
],
  "dryRun": false
}

- dryRun decide si solo se ve en los logs como quedaría o si lo hace. Si es false hará directamente los insert, si es true en los logs se verá cómo quedaría, pero no hará insert.
- assetIds se deben de colocar los id de los asset, pueden ser varios separados por coma.
