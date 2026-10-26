# Cave Graphics

Panel web interno para organizar tareas y recursos graficos del estudio. La lista se guarda en Supabase y se sincroniza mediante una funcion Edge protegida.

## Publicacion

El sitio se publica con GitHub Pages desde la rama `main`:

https://isaaclorenzo.github.io/cave-graphics-panel/

## Acceso

El sitio abre directamente, sin cuentas, correos ni claves. Cualquier persona que tenga la direccion puede ver, editar y borrar proyectos y cobros.

## Seguridad

- La tabla `tasks` no acepta accesos publicos directos.
- Todas las lecturas y escrituras pasan por `supabase/functions/cave-board`.
- `SUPABASE_SERVICE_ROLE_KEY` solo existe dentro de la funcion Edge.
- La funcion acepta unicamente los origenes de GitHub Pages: `https://isaaclorenzo.github.io` y el anterior `https://kratos561.github.io`. Para agregar otro, define el secreto `CAVE_ALLOWED_ORIGIN` (lista separada por comas).

## Supabase

- `supabase/migrations/20260721_secure_cave_board.sql` cierra RLS y normaliza estados y prioridades.
- `supabase/functions/cave-board/index.ts` contiene el backend protegido.
- `supabase/config.toml` mantiene `verify_jwt = false` porque la funcion es de acceso abierto.
- Tras cambiar la funcion, publicala con `supabase functions deploy cave-board`.

## Uso

- Agrega proyectos con cliente, descripcion, fecha, abono, etapa y prioridad.
- Busca, edita, marca como listo y archiva proyectos.
- La papelera permite restaurar o eliminar definitivamente.
- El tablero actualiza los datos periodicamente desde la funcion segura.
