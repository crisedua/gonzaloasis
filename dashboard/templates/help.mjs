/**
 * dashboard/templates/help.mjs — Help & capabilities reference page (Spanish)
 */

import { layout } from './layout.mjs';

export function helpPage() {
  return layout({
    title: 'Ayuda',
    activeTab: 'help',
    content: `
    <h1 class="page-title">Ayuda y Capacidades</h1>
    <p class="page-subtitle">Todo lo que tu asistente de IA puede hacer, via Telegram o el panel web.</p>

    <!-- Resumen rapido -->
    <div class="stats-row" style="margin-bottom: 24px;">
      <div class="stat-card"><div class="stat-number">30+</div><div class="stat-label">Comandos</div></div>
      <div class="stat-card"><div class="stat-number">5</div><div class="stat-label">Expertos IA</div></div>
      <div class="stat-card"><div class="stat-number">5</div><div class="stat-label">Integraciones</div></div>
      <div class="stat-card"><div class="stat-number">24/7</div><div class="stat-label">Disponible</div></div>
    </div>

    <!-- IA Conversacional -->
    <div class="admin-section">
      <h2 class="admin-section-title">IA Conversacional</h2>
      <div class="admin-card">
        <p>Envia cualquier mensaje al bot en Telegram y respondera usando Claude.
        Recuerda el contexto de la conversacion y tiene acceso a tu memoria, metas, calendario, tareas y correo.</p>
        <table>
          <thead><tr><th>Comando</th><th>Descripcion</th></tr></thead>
          <tbody>
            <tr><td><code>/start</code></td><td>Mensaje de bienvenida + estado de archivos de memoria</td></tr>
            <tr><td><code>/clear</code></td><td>Borrar historial de conversacion (empezar de cero)</td></tr>
            <tr><td><code>/status</code></td><td>Mostrar archivos de memoria cargados + modelo actual</td></tr>
            <tr><td><code>/help</code></td><td>Listar todos los comandos disponibles</td></tr>
            <tr><td><code>/search &lt;consulta&gt;</code></td><td>Busqueda web, resumida por IA</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Sistema de Memoria -->
    <div class="admin-section">
      <h2 class="admin-section-title">Sistema de Memoria</h2>
      <div class="admin-card">
        <p>El bot mantiene una memoria persistente usando archivos Markdown y un indice de busqueda SQLite FTS5.
        Las conversaciones diarias se registran e indexan automaticamente.</p>
        <table>
          <thead><tr><th>Comando</th><th>Descripcion</th></tr></thead>
          <tbody>
            <tr><td><code>/memory &lt;consulta&gt;</code></td><td>Busqueda full-text en toda la memoria indexada</td></tr>
            <tr><td><code>/remember &lt;texto&gt;</code></td><td>Guardar un hecho en la memoria a largo plazo</td></tr>
            <tr><td><code>/doc &lt;tema&gt;</code></td><td>Generar un documento Markdown en documents/</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Metas -->
    <div class="admin-section">
      <h2 class="admin-section-title">Metas y Productividad</h2>
      <div class="admin-card">
        <p>Define y da seguimiento a metas con revisiones guiadas por IA. Las metas se sincronizan con Todoist automaticamente.</p>
        <table>
          <thead><tr><th>Comando</th><th>Descripcion</th></tr></thead>
          <tbody>
            <tr><td><code>/goals</code></td><td>Iniciar sesion interactiva de revision de metas</td></tr>
            <tr><td><code>/newgoal</code></td><td>Crear una nueva meta con preguntas guiadas por IA</td></tr>
            <tr><td><code>/gstatus</code></td><td>Resumen rapido de todas las metas (muestra IDs)</td></tr>
            <tr><td><code>/gupdate &lt;id&gt; &lt;estado&gt;</code></td><td>Cambiar estado de meta (active/paused/completed/archived)</td></tr>
            <tr><td><code>/gmetric &lt;id&gt; &lt;texto&gt;</code></td><td>Registrar una actualizacion de metrica</td></tr>
            <tr><td><code>/gadd &lt;id&gt; &lt;accion&gt;</code></td><td>Agregar una nueva accion a una meta</td></tr>
            <tr><td><code>/gdelete &lt;id&gt;</code></td><td>Eliminar una meta permanentemente</td></tr>
            <tr><td><code>/goals_diagram</code></td><td>Generar diagrama visual Excalidraw de metas</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Todoist -->
    <div class="admin-section">
      <h2 class="admin-section-title">Todoist</h2>
      <div class="admin-card">
        <p>Las acciones de metas se sincronizan a Todoist como tareas. Cada meta se convierte en un proyecto de Todoist.</p>
        <table>
          <thead><tr><th>Comando</th><th>Descripcion</th></tr></thead>
          <tbody>
            <tr><td><code>/tsync</code></td><td>Enviar acciones pendientes a Todoist</td></tr>
            <tr><td><code>/ttasks</code></td><td>Mostrar tareas abiertas de Todoist</td></tr>
            <tr><td><code>/tpull</code></td><td>Traer tareas completadas de Todoist &rarr; marcar como hechas</td></tr>
            <tr><td><code>/tclear &lt;id&gt;</code></td><td>Eliminar todas las tareas de Todoist para una meta</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Freedcamp -->
    <div class="admin-section">
      <h2 class="admin-section-title">Freedcamp</h2>
      <div class="admin-card">
        <p>Ver y gestionar proyectos y tareas de Freedcamp directamente desde Telegram.</p>
        <table>
          <thead><tr><th>Comando</th><th>Descripcion</th></tr></thead>
          <tbody>
            <tr><td><code>/fc</code></td><td>Mostrar todos los proyectos + tareas abiertas</td></tr>
            <tr><td><code>/fc &lt;pregunta&gt;</code></td><td>Preguntar a la IA sobre tus tareas de Freedcamp</td></tr>
            <tr><td><code>/delete-task</code></td><td>Flujo guiado para eliminar tareas</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Gmail -->
    <div class="admin-section">
      <h2 class="admin-section-title">Gmail</h2>
      <div class="admin-card">
        <p>Leer, buscar, enviar y responder correos. Requiere conexion Google OAuth.</p>
        <table>
          <thead><tr><th>Comando</th><th>Descripcion</th></tr></thead>
          <tbody>
            <tr><td><code>/gauth</code></td><td>Conectar cuenta de Google (OAuth)</td></tr>
            <tr><td><code>/gmail</code></td><td>Mostrar correos no leidos</td></tr>
            <tr><td><code>/gsearch &lt;consulta&gt;</code></td><td>Buscar en Gmail</td></tr>
            <tr><td><code>/gread &lt;id&gt;</code></td><td>Leer un correo completo</td></tr>
            <tr><td><code>/gsummarise &lt;id&gt;</code></td><td>Resumen con IA de un correo</td></tr>
            <tr><td><code>/gsend &lt;para&gt; | &lt;asunto&gt; | &lt;cuerpo&gt;</code></td><td>Enviar un correo</td></tr>
            <tr><td><code>/greply &lt;id&gt; | &lt;cuerpo&gt;</code></td><td>Responder a un correo</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Google Drive -->
    <div class="admin-section">
      <h2 class="admin-section-title">Google Drive</h2>
      <div class="admin-card">
        <table>
          <thead><tr><th>Comando</th><th>Descripcion</th></tr></thead>
          <tbody>
            <tr><td><code>/drive</code></td><td>Listar archivos recientes de Drive</td></tr>
            <tr><td><code>/drsearch &lt;consulta&gt;</code></td><td>Buscar archivos en Drive</td></tr>
            <tr><td><code>/drread &lt;id&gt;</code></td><td>Leer un archivo de Drive</td></tr>
            <tr><td><code>/drcreate &lt;titulo&gt; | &lt;contenido&gt;</code></td><td>Crear un Google Doc</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Google Calendar -->
    <div class="admin-section">
      <h2 class="admin-section-title">Google Calendar</h2>
      <div class="admin-card">
        <table>
          <thead><tr><th>Comando</th><th>Descripcion</th></tr></thead>
          <tbody>
            <tr><td><code>/gcal</code></td><td>Mostrar proximos eventos del calendario (10)</td></tr>
            <tr><td><code>/gcaltoday</code></td><td>Mostrar solo los eventos de hoy</td></tr>
            <tr><td><code>/gcalsearch &lt;consulta&gt;</code></td><td>Buscar eventos en el calendario</td></tr>
            <tr><td><code>/gcalevent &lt;id&gt;</code></td><td>Ver detalles completos de un evento</td></tr>
            <tr><td><code>/gccreate &lt;titulo&gt; | &lt;inicio&gt; | &lt;fin&gt; [| desc] [| lugar]</code></td><td>Crear un evento</td></tr>
            <tr><td><code>/gcdelete &lt;id&gt;</code></td><td>Eliminar un evento</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- AI Super Team -->
    <div class="admin-section">
      <h2 class="admin-section-title">AI Super Team &mdash; 5 Marketing Legends as Claude Skills</h2>
      <div class="admin-card">
        <p>Activa uno o todos los 5 expertos simultaneamente como junta directiva de asesores para cualquier pregunta de negocios.
        Cada experto analiza tu situacion a traves de su lente especifico, usando sus frameworks especificos, con su voz propia.</p>
        <table>
          <thead><tr><th>Comando</th><th>Descripcion</th></tr></thead>
          <tbody>
            <tr><td><code>/expert</code></td><td>Iniciar sesion del Super Team (elegir experto o todos)</td></tr>
          </tbody>
        </table>
        <p style="margin-top: 12px; color: var(--text-dim);">Di <strong>"marketing equipo"</strong> o <strong>"preguntar 5 expertos"</strong> seguido de tu situacion de negocio.
        Comparte tu oferta, numeros y cuello de botella actual para el consejo mas accionable.</p>
      </div>
    </div>

    <!-- Hormozi -->
    <div class="admin-section">
      <div class="admin-card">
        <h3 style="color: var(--accent); margin-top: 0;">Alex Hormozi &mdash; The Offer Architect</h3>
        <p><strong>Su lente:</strong> &iquest;La oferta es lo suficientemente atractiva? &iquest;El precio es correcto? &iquest;El stack de valor esta completo?</p>
        <p><strong>Frameworks:</strong> Value Equation, Grand Slam Offer (5 pasos), Core Four, Lead Magnets, MAGIC Naming, Guarantee Types, Rule of 100, More Better New</p>
        <p><strong>Diagnostica:</strong> Ofertas debiles, precios bajos, posicionamiento comoditizado, garantias faltantes, ecuaciones de valor rotas, volumen insuficiente de outreach</p>
        <p style="color: var(--text-dim);">Di: <em>"Audit my offer"</em> &middot; <em>"Run my business through the Value Equation"</em> &middot; <em>"Help me build a Grand Slam Offer"</em></p>
      </div>
    </div>

    <!-- Ogilvy -->
    <div class="admin-section">
      <div class="admin-card">
        <h3 style="color: var(--accent); margin-top: 0;">David Ogilvy &mdash; The Copy Chief</h3>
        <p><strong>Su lente:</strong> &iquest;El mensaje persuade? &iquest;El copy es honesto, especifico y basado en investigacion?</p>
        <p><strong>Frameworks:</strong> Research-First Discipline, Big Idea, Headline Rules, Body Copy Principles, 11 Commandments, Brand Image Philosophy, Direct Response Wisdom</p>
        <p><strong>Diagnostica:</strong> Titulares vagos, copy vacio, sin Big Idea, inconsistencia de marca, priorizar estilo sobre sustancia, falta de hechos especificos</p>
        <p style="color: var(--text-dim);">Di: <em>"Review this headline"</em> &middot; <em>"Audit my landing page copy"</em> &middot; <em>"Help me find the Big Idea for my brand"</em></p>
      </div>
    </div>

    <!-- Gary Vee -->
    <div class="admin-section">
      <div class="admin-card">
        <h3 style="color: var(--accent); margin-top: 0;">Gary Vaynerchuk &mdash; The Content Strategist</h3>
        <p><strong>Su lente:</strong> &iquest;La estrategia de contenido es correcta? &iquest;Estas publicando suficiente? &iquest;Estas ganando atencion?</p>
        <p><strong>Frameworks:</strong> Jab Jab Jab Right Hook, Pillar-to-Micro Content Model, Day Trading Attention, $1.80 Strategy, Document Don't Create, Context &gt; Content, Reverse Pyramid</p>
        <p><strong>Diagnostica:</strong> Poco volumen de contenido, copiar y pegar entre plataformas, demasiada venta sin dar valor, sin sistema de contenido pilar, marca personal debil</p>
        <p style="color: var(--text-dim);">Di: <em>"Build me a content strategy for LinkedIn"</em> &middot; <em>"Help me set up a pillar-to-micro content system"</em> &middot; <em>"Create a 30-day content plan"</em></p>
      </div>
    </div>

    <!-- Brunson -->
    <div class="admin-section">
      <div class="admin-card">
        <h3 style="color: var(--accent); margin-top: 0;">Russell Brunson &mdash; The Funnel Architect</h3>
        <p><strong>Su lente:</strong> &iquest;El embudo convierte? &iquest;La escalera de valor esta completa? &iquest;Las historias son convincentes?</p>
        <p><strong>Frameworks:</strong> Secret Formula, Value Ladder, Hook Story Offer, Attractive Character, Epiphany Bridge, Perfect Webinar Script, Stack &amp; Close, Soap Opera Sequence, Dream 100, Funnel Hacking</p>
        <p><strong>Diagnostica:</strong> Escalones faltantes en la escalera de valor, sin storytelling en ventas, estructura de embudo rota, sin secuencias de email, sin follow-up</p>
        <p style="color: var(--text-dim);">Di: <em>"Build me a funnel"</em> &middot; <em>"Write a Perfect Webinar script"</em> &middot; <em>"Create my Value Ladder"</em></p>
      </div>
    </div>

    <!-- Suby -->
    <div class="admin-section">
      <div class="admin-card">
        <h3 style="color: var(--accent); margin-top: 0;">Sabri Suby &mdash; The Lead Gen Strategist</h3>
        <p><strong>Su lente:</strong> &iquest;El sistema de generacion de leads es rentable? &iquest;Los numeros funcionan? &iquest;El follow-up esta automatizado?</p>
        <p><strong>Frameworks:</strong> Larger Market Formula, 8-Phase Selling System, HVCO Creation, Godfather Offer, Magic Lantern Technique, Sell Like a Doctor, Unit Economics, Halo Strategy, Dream 100</p>
        <p><strong>Diagnostica:</strong> Sin tracking de unit economics, sin HVCO, vendiendo directamente a trafico frio, sin secuencia de nurture, sin retargeting, follow-up roto</p>
        <p style="color: var(--text-dim);">Di: <em>"Build me a lead gen system"</em> &middot; <em>"Create an HVCO for my business"</em> &middot; <em>"Audit my acquisition funnel"</em></p>
      </div>
    </div>

    <!-- Lenguaje Natural -->
    <div class="admin-section">
      <h2 class="admin-section-title">Lenguaje Natural</h2>
      <div class="admin-card">
        <p>No necesitas usar comandos. El bot tambien responde a lenguaje natural:</p>
        <table>
          <thead><tr><th>Di algo como...</th><th>Que pasa</th></tr></thead>
          <tbody>
            <tr><td>"planifica mi dia" / "morning briefing"</td><td>Ejecuta la planificacion matutina</td></tr>
            <tr><td>"revisar mis metas" / "goal review"</td><td>Inicia revision interactiva de metas</td></tr>
            <tr><td>"audit my offer" / "review my copy"</td><td>Activa sesion de experto del Super Team</td></tr>
            <tr><td>"marketing equipo" / "preguntar 5 expertos"</td><td>Ejecuta los 5 expertos simultaneamente</td></tr>
            <tr><td>"help me get leads" / "lead gen plan"</td><td>Sesion de estrategia de generacion de leads</td></tr>
            <tr><td>"escribir post de LinkedIn"</td><td>Asistente de creacion de contenido LinkedIn</td></tr>
            <tr><td>"visualizar mis metas"</td><td>Genera diagrama Excalidraw de metas</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Panel Web -->
    <div class="admin-section">
      <h2 class="admin-section-title">Panel Web</h2>
      <div class="admin-card">
        <p>Accede al panel enviando <code>/dashboard</code> en Telegram. Incluye:</p>
        <div class="grid-2" style="margin-top: 12px;">
          <div class="card" style="margin: 0;">
            <div class="card-title">Overview</div>
            <div class="card-meta">Estadisticas de metas, documentos recientes, metricas de memoria</div>
          </div>
          <div class="card" style="margin: 0;">
            <div class="card-title">Goals</div>
            <div class="card-meta">Ver todas las metas con estado, metricas y acciones</div>
          </div>
          <div class="card" style="margin: 0;">
            <div class="card-title">Documents</div>
            <div class="card-meta">Explorar documentos generados e informes de estrategia</div>
          </div>
          <div class="card" style="margin: 0;">
            <div class="card-title">Memory</div>
            <div class="card-meta">Busqueda full-text en la memoria indexada</div>
          </div>
          <div class="card" style="margin: 0;">
            <div class="card-title">History</div>
            <div class="card-meta">Registros diarios de conversacion por fecha</div>
          </div>
          <div class="card" style="margin: 0;">
            <div class="card-title">Calendar</div>
            <div class="card-meta">Proximos eventos de Google Calendar</div>
          </div>
          <div class="card" style="margin: 0;">
            <div class="card-title">Admin</div>
            <div class="card-meta">Configurar integraciones, probar conexiones, gestionar credenciales</div>
          </div>
        </div>
      </div>
    </div>
    `,
  });
}
