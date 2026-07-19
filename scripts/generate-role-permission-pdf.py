from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "pdf" / "OrderPRO-matriz-roles-permisos.pdf"

NAVY = colors.HexColor("#08111F")
PANEL = colors.HexColor("#111C2E")
GRID = colors.HexColor("#263449")
GREEN = colors.HexColor("#34D399")
GREEN_DARK = colors.HexColor("#064E3B")
AMBER = colors.HexColor("#FCD34D")
TEXT = colors.HexColor("#E5E7EB")
MUTED = colors.HexColor("#94A3B8")

ROLES = [
    ("OWNER", "Owner"),
    ("OPERATIONS_ADMIN", "Operations admin"),
    ("INVENTORY_CONTROLLER", "Inventory controller"),
    ("STORE_MANAGER", "Store manager"),
    ("STORE_STAFF", "Store staff"),
    ("WAREHOUSE_MANAGER", "Warehouse manager"),
    ("WAREHOUSE_STAFF", "Warehouse staff"),
    ("AUDITOR", "Auditor"),
]

PERMISSIONS = [
    ("dashboard.view", "Ver panel general"),
    ("boxes.view", "Ver cajas"),
    ("boxes.mutate", "Crear o modificar cajas"),
    ("inventory.view", "Ver inventario"),
    ("fulfillment.view", "Ver fulfillment"),
    ("fulfillment.manage", "Administrar borradores de fulfillment"),
    ("fulfillment.publish", "Publicar configuración de fulfillment"),
    ("fulfillment.rollback", "Crear rollback de fulfillment"),
    ("admin.manage", "Administrar usuarios"),
    ("m2m.approve", "Aprobar acceso M2M de STAGING"),
]

GRANTS = {
    "OWNER": {permission for permission, _ in PERMISSIONS},
    "OPERATIONS_ADMIN": {
        "dashboard.view",
        "boxes.view",
        "boxes.mutate",
        "inventory.view",
        "fulfillment.view",
        "fulfillment.manage",
        "admin.manage",
    },
    "INVENTORY_CONTROLLER": {
        "dashboard.view",
        "boxes.view",
        "boxes.mutate",
        "inventory.view",
        "fulfillment.view",
    },
    "STORE_MANAGER": {
        "dashboard.view",
        "boxes.view",
        "boxes.mutate",
        "inventory.view",
        "fulfillment.view",
    },
    "STORE_STAFF": {"dashboard.view", "boxes.view", "boxes.mutate"},
    "WAREHOUSE_MANAGER": {
        "dashboard.view",
        "boxes.view",
        "boxes.mutate",
        "inventory.view",
        "fulfillment.view",
    },
    "WAREHOUSE_STAFF": {"dashboard.view", "boxes.view", "boxes.mutate"},
    "AUDITOR": {
        "dashboard.view",
        "boxes.view",
        "inventory.view",
        "fulfillment.view",
    },
}


styles = getSampleStyleSheet()
title_style = ParagraphStyle(
    "Title",
    parent=styles["Title"],
    fontName="Helvetica-Bold",
    fontSize=25,
    leading=29,
    textColor=TEXT,
    alignment=TA_LEFT,
    spaceAfter=7,
)
section_style = ParagraphStyle(
    "Section",
    parent=styles["Heading2"],
    fontName="Helvetica-Bold",
    fontSize=16,
    leading=19,
    textColor=TEXT,
    spaceAfter=8,
)
subtitle_style = ParagraphStyle(
    "Subtitle",
    parent=styles["BodyText"],
    fontName="Helvetica",
    fontSize=8.5,
    leading=12,
    textColor=MUTED,
)
body_style = ParagraphStyle(
    "Body",
    parent=styles["BodyText"],
    fontName="Helvetica",
    fontSize=7.4,
    leading=9.4,
    textColor=TEXT,
)
small_style = ParagraphStyle(
    "Small",
    parent=body_style,
    fontSize=6.2,
    leading=7.7,
)
code_style = ParagraphStyle(
    "Code",
    parent=small_style,
    fontName="Courier",
    textColor=MUTED,
)
header_cell_style = ParagraphStyle(
    "HeaderCell",
    parent=small_style,
    fontName="Helvetica-Bold",
    textColor=TEXT,
    alignment=TA_LEFT,
)


def p(text, style=body_style):
    return Paragraph(text, style)


def draw_page(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(NAVY)
    canvas.rect(0, 0, letter[0], letter[1], fill=1, stroke=0)
    canvas.setFillColor(GREEN)
    canvas.setFont("Helvetica-Bold", 8)
    canvas.drawString(doc.leftMargin, letter[1] - 24, "ORDERPRO")
    canvas.setStrokeColor(GRID)
    canvas.line(doc.leftMargin, 29, letter[0] - doc.rightMargin, 29)
    canvas.setFillColor(MUTED)
    canvas.setFont("Helvetica", 6.5)
    canvas.drawString(doc.leftMargin, 17, "ORDERPRO | CONTROL DE ACCESO")
    canvas.drawRightString(
        letter[0] - doc.rightMargin, 17, f"Página {canvas.getPageNumber()}"
    )
    canvas.restoreState()


def dark_table(data, widths, row_heights=None, font_size=6.4):
    table = Table(data, colWidths=widths, rowHeights=row_heights, repeatRows=1)
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), PANEL),
                ("TEXTCOLOR", (0, 0), (-1, -1), TEXT),
                ("GRID", (0, 0), (-1, -1), 0.45, GRID),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, -1), font_size),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [NAVY, colors.HexColor("#0D1727")]),
            ]
        )
    )
    return table


def build_story():
    story = [Spacer(1, 0.12 * inch)]
    story.extend(
        [
            p("Matriz de roles y permisos", title_style),
            p(
                "Versión actual del sistema - 19 de julio de 2026 - Documento de referencia operativa",
                subtitle_style,
            ),
            Spacer(1, 0.17 * inch),
        ]
    )

    stats = [
        [p("8", section_style), p("10", section_style), p("6", section_style), p("100%", section_style)],
        [p("roles definidos", small_style), p("permisos base", small_style), p("secciones operativas", small_style), p("validación en servidor", small_style)],
    ]
    stats_table = Table(stats, colWidths=[1.9125 * inch] * 4)
    stats_table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), PANEL),
                ("BOX", (0, 0), (-1, -1), 0.6, GRID),
                ("INNERGRID", (0, 0), (-1, -1), 0.45, GRID),
                ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("TOPPADDING", (0, 0), (-1, 0), 8),
                ("BOTTOMPADDING", (0, 1), (-1, 1), 8),
            ]
        )
    )
    story.extend([stats_table, Spacer(1, 0.22 * inch), p("Matriz de acceso", section_style)])

    role_headers = [
        "Permiso",
        "Owner",
        "Ops<br/>admin",
        "Inventory<br/>ctrl.",
        "Store<br/>mgr.",
        "Store<br/>staff",
        "Warehouse<br/>mgr.",
        "Warehouse<br/>staff",
        "Auditor",
    ]
    matrix = [[p(value, header_cell_style) for value in role_headers]]
    for permission, label in PERMISSIONS:
        row = [p(f"<b>{label}</b><br/><font name='Courier' color='#94A3B8'>{permission}</font>", small_style)]
        for role, _ in ROLES:
            allowed = permission in GRANTS[role]
            row.append(p("SI" if allowed else "-", header_cell_style))
        matrix.append(row)
    matrix_table = dark_table(matrix, [2.15 * inch] + [0.6875 * inch] * 8, font_size=6.2)
    matrix_table.setStyle(
        TableStyle(
            [
                ("ALIGN", (1, 0), (-1, -1), "CENTER"),
                ("TEXTCOLOR", (1, 1), (-1, -1), MUTED),
            ]
        )
    )
    for row_index, (permission, _) in enumerate(PERMISSIONS, start=1):
        for column_index, (role, _) in enumerate(ROLES, start=1):
            if permission in GRANTS[role]:
                matrix_table.setStyle(
                    TableStyle(
                        [
                            ("BACKGROUND", (column_index, row_index), (column_index, row_index), GREEN_DARK),
                            ("TEXTCOLOR", (column_index, row_index), (column_index, row_index), GREEN),
                        ]
                    )
                )
    story.extend(
        [
            matrix_table,
            Spacer(1, 0.1 * inch),
            p(
                "SI indica que el rol concede el permiso. Un guion indica que no lo concede. Las restricciones de ubicación siguen aplicando aunque el permiso esté habilitado.",
                small_style,
            ),
            PageBreak(),
            Spacer(1, 0.12 * inch),
            p("Secciones y gobernanza", title_style),
            p("Visibilidad del front y reglas transversales de autorización.", subtitle_style),
            Spacer(1, 0.18 * inch),
            p("Secciones disponibles en el front", section_style),
        ]
    )

    sections = [
        ("Panel general", "/operations", "dashboard.view", "Solo aparece y abre para usuarios con acceso al panel."),
        ("Cajas", "/operations/boxes", "boxes.view<br/>boxes.mutate", "Ver cajas requiere boxes.view. Crear o modificar requiere boxes.mutate y la acción se valida otra vez en el servidor."),
        ("Inventario", "/operations/inventory", "inventory.view", "Se oculta de la navegación y se bloquea la ruta sin permiso."),
        ("Fulfillment", "/operations/fulfillment", "fulfillment.view<br/>fulfillment.manage<br/>fulfillment.publish<br/>fulfillment.rollback", "Walking delivery y shipping vía Englewood. Guardar, publicar y rollback son acciones separadas; solo Owner publica o revierte."),
        ("Usuarios y auditoría", "/operations/admin/users<br/>/operations/admin/audit", "admin.manage", "Incluye invitaciones, edición de acceso, matriz de roles y registro de auditoría."),
        ("M2M STAGING", "/operations/admin/m2m", "m2m.approve", "Visible solo para Owner. Registra APPROVED_PENDING_ACTIVATION con sesión Supabase; no activa cliente, credencial, grants ni runtime."),
    ]
    section_rows = [[p("Sección", header_cell_style), p("Ruta", header_cell_style), p("Permiso", header_cell_style), p("Comportamiento", header_cell_style)]]
    for name, route, permission, behavior in sections:
        section_rows.append([p(name), p(route, code_style), p(permission, code_style), p(behavior)])
    story.extend(
        [
            dark_table(section_rows, [1.05 * inch, 1.45 * inch, 1.35 * inch, 3.8 * inch]),
            Spacer(1, 0.2 * inch),
            p("Reglas transversales", section_style),
        ]
    )

    rules = [
        ("Roles combinados", "Si una persona recibe varios roles, sus permisos se combinan. Un permiso concedido por cualquiera de los roles queda habilitado."),
        ("Ubicaciones activas", "Cada cuenta debe tener al menos un rol y una ubicación activa. Las consultas operativas se limitan a las ubicaciones asignadas."),
        ("Compatibilidad", "Los roles Store se asignan a tiendas y los roles Warehouse a almacenes. Owner, Operations admin, Inventory controller y Auditor pueden abarcar ambos tipos."),
        ("Seguridad administrativa", "Un administrador no puede retirarse a sí mismo el acceso administrativo. Solo un Owner administra acceso Owner y siempre debe permanecer al menos uno activo."),
        ("Aprobación M2M", "m2m.approve pertenece exclusivamente a Owner. La acción deriva el actor de la sesión, exige evidencia certificada y conserva todos los estados de autorización pendientes."),
    ]
    rule_rows = [[p("Regla", header_cell_style), p("Aplicación", header_cell_style)]]
    rule_rows.extend([[p(name), p(description)] for name, description in rules])
    story.extend(
        [
            dark_table(rule_rows, [1.45 * inch, 6.2 * inch]),
            Spacer(1, 0.12 * inch),
            p(
                "Fuente de verdad: src/application/auth/permissions.ts y src/application/admin/user-management-policy.ts.",
                small_style,
            ),
            PageBreak(),
            Spacer(1, 0.12 * inch),
            p("Detalle por rol", title_style),
            p("Los nombres técnicos se muestran para facilitar auditorías y soporte.", subtitle_style),
            Spacer(1, 0.18 * inch),
        ]
    )

    limits = {
        "OWNER": "Acceso total. Es el único rol que publica, crea rollback y aprueba M2M de STAGING. La aprobación M2M permanece pendiente de activación. El sistema conserva al menos un Owner activo.",
        "OPERATIONS_ADMIN": "Administra borradores de fulfillment y usuarios, pero no publica, crea rollback ni aprueba M2M. No puede modificar acceso Owner.",
        "INVENTORY_CONTROLLER": "Gestiona cajas, consulta inventario y ve fulfillment. No modifica configuraciones ni aprueba M2M.",
        "STORE_MANAGER": "Opera cajas e inventario y ve fulfillment para las tiendas asignadas. No modifica configuraciones.",
        "STORE_STAFF": "Opera cajas en las tiendas asignadas. No ve inventario ni administra usuarios.",
        "WAREHOUSE_MANAGER": "Opera cajas e inventario y ve fulfillment para los almacenes asignados. No modifica configuraciones.",
        "WAREHOUSE_STAFF": "Opera cajas en los almacenes asignados. No ve inventario ni administra usuarios.",
        "AUDITOR": "Acceso de solo lectura al panel, cajas, inventario y fulfillment. No modifica configuraciones.",
    }
    labels = dict(PERMISSIONS)
    role_rows = [[p("Rol", header_cell_style), p("Permisos otorgados", header_cell_style), p("Alcance y límites", header_cell_style)]]
    for role, role_label in ROLES:
        granted = "<br/>".join(
            f"- {labels[permission]}"
            for permission, _ in PERMISSIONS
            if permission in GRANTS[role]
        )
        role_rows.append(
            [
                p(f"<b>{role_label}</b><br/><font name='Courier' color='#94A3B8'>{role}</font>", small_style),
                p(granted, small_style),
                p(limits[role], small_style),
            ]
        )
    story.extend(
        [
            dark_table(role_rows, [1.4 * inch, 2.85 * inch, 3.4 * inch], font_size=6.1),
            Spacer(1, 0.12 * inch),
            p(
                "Este documento describe permisos base. La sesión, el estado de cuenta, la ubicación activa, los gates del entorno y las validaciones de cada transacción siguen siendo obligatorios.",
                small_style,
            ),
        ]
    )
    return story


def main():
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    document = SimpleDocTemplate(
        str(OUTPUT),
        pagesize=letter,
        rightMargin=0.42 * inch,
        leftMargin=0.42 * inch,
        topMargin=0.48 * inch,
        bottomMargin=0.46 * inch,
        title="OrderPRO - Matriz de roles y permisos",
        author="OrderPRO",
        subject="Control de acceso operativo",
    )
    document.build(build_story(), onFirstPage=draw_page, onLaterPages=draw_page)
    print(OUTPUT)


if __name__ == "__main__":
    main()
