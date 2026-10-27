# Cave Graphics

Panel web interno para organizar tareas y recursos graficos del estudio. La lista se guarda en Supabase y se sincroniza mediante una funcion Edge.

## Publicacion

El sitio se publica con GitHub Pages desde la rama `main`:

https://isaaclorenzo.github.io/cave-graphics-panel/

## Acceso

El sitio abre directamente, sin cuentas, correos ni claves. Cualquier persona que tenga la direccion puede ver, editar y borrar proyectos y cobros; por eso todo cambio queda registrado y se puede recuperar.

## Rapidez

- Cada accion se ve al instante y se guarda en segundo plano.
- Si no hay conexion, los cambios esperan en el navegador y se envian solos al volver.
- Los iconos se sirven desde `assets/icons.js` (solo los usados, generados desde Lucide) en lugar de una libreria externa.

## Seguridad

- La tabla `tasks` no acepta accesos publicos directos; todas las lecturas y escrituras pasan por `supabase/functions/cave-board`.
- `SUPABASE_SERVICE_ROLE_KEY` solo existe dentro de la funcion Edge.
- La funcion solo atiende peticiones con el origen `https://isaaclorenzo.github.io` (la direccion antigua `kratos561.github.io` ya no es de confianza). Para agregar otro, define el secreto `CAVE_ALLOWED_ORIGIN` (lista separada por comas).
- Limites por IP: solicitudes por minuto, escrituras por minuto y borrados definitivos por hora.
- Valida cada campo, limita el tamano de las solicitudes y nunca devuelve detalles internos de la base de datos.
- `activity_log` guarda una copia de cada alta, cambio y borrado (via triggers en la base de datos). Lo eliminado se recupera desde **Actividad**. Se conserva 180 dias.
- La pagina declara una Content Security Policy: solo ejecuta scripts propios y solo se conecta con Supabase.

## Supabase

- `supabase/migrations/20260721_secure_cave_board.sql` cierra RLS y normaliza estados y prioridades.
- `supabase/migrations/20261027_activity_log_checklist.sql` agrega el historial de actividad y la checklist por proyecto.
- `supabase/functions/cave-board/index.ts` contiene el backend.
- `supabase/config.toml` mantiene `verify_jwt = false` porque la funcion es de acceso abierto.
- Al cambiar la funcion en `main`, el workflow `Deploy Supabase Function` la publica automaticamente (necesita el secreto `SUPABASE_ACCESS_TOKEN` en GitHub). Tambien puede publicarse a mano con `supabase functions deploy cave-board`.

## Uso

- Agrega proyectos con cliente, notas, fecha de entrega, prioridad, abono, saldo y contacto.
- Cambia el estado (Pendiente, En proceso, Listo) tocando la etiqueta del proyecto.
- Filtra por vencidos, hoy, proximos 7 dias, prioritarios o con saldo, y ordena por entrega, prioridad o recientes.
- Cada proyecto puede tener una checklist de pasos con su progreso visible en la tarjeta.
- Escribe al cliente por WhatsApp desde la tarjeta.
- Al confirmar la entrega el proyecto pasa a **Entregados** (o a **Falta de entrega** si aun no lo retiran) y se puede reabrir.
- Casi todas las acciones se pueden deshacer desde el aviso que aparece abajo.
- La papelera elimina definitivamente a las 48 horas; aun asi el proyecto se puede recuperar desde **Actividad**.
- Atajos: `N` para un proyecto nuevo y `/` para buscar.
