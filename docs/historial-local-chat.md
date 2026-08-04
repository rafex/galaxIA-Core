# Historial local del Portal Chat

Estado: decisión MVP implementada en el Portal Chat.

## Decisiones

- El historial es estado de presentación del cliente y no forma parte del
  protocolo FHS ni se anuncia a otros peers.
- Se almacena en `localStorage` bajo la clave versionada
  `fhs.chat.history.v1`. El almacenamiento pertenece al origen y al perfil
  del navegador, por lo que sobrevive al cierre de la pestaña y del navegador,
  salvo que el usuario borre los datos del sitio o use navegación privada.
- No se usa huella de dispositivo. Una fingerprint sería invasiva, inestable
  y no es necesaria para identificar un historial local. En esta MVP tampoco
  se envía un identificador de instalación por P2P.
- El `deviceId` UUID anónimo que existe para correlación técnica, si alguna
  función futura lo necesita, no es una fingerprint ni se usa como clave del
  historial. La clave efectiva del historial sigue siendo el origen/perfil
  del navegador.
- Los adjuntos binarios no se guardan en el historial. Solo se conserva el
  nombre y la marca de que existió un adjunto; el contenido debe volver a
  seleccionarse si se necesita reenviarlo.
- El usuario puede crear conversaciones y borrar todo el historial local. La
  UI no sincroniza ni comparte este contenido automáticamente.

## Tiempos y fechas

Cada mensaje conserva un timestamp Unix en milisegundos, generado por el
navegador:

- mensaje inicial: `createdAt` del mensaje de usuario;
- respuesta visible: `createdAt` cuando llega el primer delta visible del
  asistente;
- fin: `completedAt` cuando llega `assistant.completed`;
- duración: `durationMs = completedAt - createdAt` del mensaje de usuario.

Cuando existe `completedAt`, la etiqueta visual de la respuesta muestra esa
hora de finalización; mientras se transmite muestra la hora del primer delta.

La hora se muestra en la zona horaria local del navegador. Los mensajes se
separan por el día local (`Hoy`, `Ayer` o fecha completa), como en WhatsApp.
La duración corresponde al ciclo completo observado por el Portal, incluyendo
selección de modelo y herramientas; no pretende ser una medición interna del
modelo.

## Evolución posterior

Si se requiere historial entre dispositivos, debe ser una acción explícita del
usuario: exportación/importación cifrada o sincronización P2P autenticada con
una identidad controlada por el usuario. No se debe sustituir esto por una
fingerprint silenciosa ni enviar el historial a un proveedor.

## Criterios de aceptación

1. Al recargar o cerrar y volver a abrir la pestaña, las conversaciones locales
   siguen visibles en el mismo perfil del navegador.
2. Cada mensaje muestra hora local; cada respuesta completada muestra su
   duración.
3. Los mensajes se agrupan por día local.
4. Cambiar de conversación no mezcla mensajes ni eventos de la sesión activa.
5. Borrar el historial elimina el contenido local y no genera tráfico FHS.
