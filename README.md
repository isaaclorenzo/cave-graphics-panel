# Cave Graphics

Panel web interno para organizar tareas y recursos graficos del estudio. La lista se guarda en Supabase y se sincroniza mediante una funcion Edge protegida.

## Publicacion

El sitio se publica con GitHub Pages desde la rama `main`:

https://isaaclorenzo.github.io/cave-graphics-panel/

## Acceso privado

El sitio no utiliza cuentas ni correos. El acceso se concede mediante un enlace-capacidad con este formato:

`https://isaaclorenzo.github.io/cave-graphics-panel/#access=CLAVE_SECRETA`

La clave vive solamente en Supabase como un hash, nunca en este repositorio ni dentro de `index.html`. El navegador la guarda por sesion y elimina el fragmento de la barra de direcciones despues de validarlo.

Para revocar todos los enlaces, genera una clave nueva, calcula su SHA-256 y actualiza el secreto `CAVE_ACCESS_SECRET_SHA256` en Supabase.

## Seguridad

- La tabla `tasks` no acepta accesos publicos directos.
- Todas las lecturas y escrituras pasan por `supabase/functions/cave-board`.
- La funcion valida `x-cave-access` antes de consultar la tabla.
- `SUPABASE_SERVICE_ROLE_KEY` solo existe dentro de la funcion Edge.
- La funcion acepta unicamente los origenes de GitHub Pages: `https://isaaclorenzo.github.io` y el anterior `https://kratos561.github.io`. Para agregar otro, define el secreto `CAVE_ALLOWED_ORIGIN` (lista separada por comas).

## Supabase

- `supabase/migrations/20260721_secure_cave_board.sql` cierra RLS y normaliza estados y prioridades.
- `supabase/functions/cave-board/index.ts` contiene el backend protegido.
- `supabase/config.toml` mantiene `verify_jwt = false` porque la funcion usa su propia clave-capacidad.
- Tras cambiar la funcion, publicala con `supabase functions deploy cave-board`.

## Uso

- Agrega proyectos con cliente, descripcion, fecha, abono, etapa y prioridad.
- Busca, edita, marca como listo y archiva proyectos.
- La papelera permite restaurar o eliminar definitivamente.
- El tablero actualiza los datos periodicamente desde la funcion segura.
