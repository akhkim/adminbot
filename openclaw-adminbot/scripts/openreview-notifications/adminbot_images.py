"""Render all announcement groups on one expanding canvas for AdminBot."""
from pathlib import Path

from openreview_notifications.images import WIDTH, MARGIN, LINE_HEIGHT, load_font, wrap_text


def write_image(announcements, directory):
    from PIL import Image, ImageDraw, ImageFont, PngImagePlugin

    font = load_font(ImageFont, 38)
    label_font = load_font(ImageFont, 27)
    heading_font = load_font(ImageFont, 54, bold=True)
    # Measure every line before allocating the canvas, keeping text at readable sizes.
    rows = [(MARGIN, 65, "ACCEPTED PAPERS", label_font, "#315e52")]
    description = []
    y = 112
    for announcement in announcements:
        for line in wrap_text(announcement["venue"], heading_font, WIDTH - 2 * MARGIN):
            rows.append((MARGIN, y, line, heading_font, "#142b26"))
            y += 70
        y += 50
        for number, paper in enumerate(announcement["papers"], 1):
            rows.append((MARGIN, y, f"{number}.", font, "#315e52"))
            for text, row_font, color in (
                (paper["title"], font, "#142b26"),
                (f"({paper['track']})", label_font, "#4c605a"),
            ):
                for line in wrap_text(text, row_font, WIDTH - 2 * MARGIN - 100):
                    rows.append((MARGIN + 100, y, line, row_font, color))
                    y += LINE_HEIGHT
            description.append(f"{number}. {paper['title']} ({paper['track']})")
            y += 35
        y += 35
    bottom = max(y + row_font.getbbox(text)[3] for _, y, text, row_font, _ in rows)
    image = Image.new("RGB", (WIDTH, bottom + MARGIN), "#faf9f6")
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, WIDTH, 16), fill="#315e52")
    for x, y, text, row_font, color in rows:
        draw.text((x, y), text, font=row_font, fill=color)
    metadata = PngImagePlugin.PngInfo()
    metadata.add_text("Description", "\n".join(description))
    path = Path(directory) / "accepted-papers.png"
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, pnginfo=metadata)
    return path
