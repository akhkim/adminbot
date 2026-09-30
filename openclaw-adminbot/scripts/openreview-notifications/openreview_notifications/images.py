"""Render accepted papers as paginated PNGs (optional Pillow dependency)."""

from pathlib import Path

WIDTH = 1200
MARGIN, TOP, BOTTOM = 80, 270, 1380
LINE_HEIGHT = 50


def load_font(ImageFont, size, bold=False):
    names = (
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf",
        "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
    )
    for name in names:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default(size=size)


def wrap_text(text, font, width):
    """Wrap by rendered width, breaking long words without dropping characters."""
    lines, line = [], ""
    for word in text.split():
        candidate = f"{line} {word}" if line else word
        if font.getlength(candidate) <= width:
            line = candidate
            continue
        if line:
            lines.append(line)
        line = ""
        for character in word:
            if line and font.getlength(line + character) > width:
                lines.append(line)
                line = ""
            line += character
    if line:
        lines.append(line)
    return lines


def layout_papers(papers, font, label_font):
    """Keep papers together where possible, continuing unusually long titles."""
    pages, page, y = [], [], TOP
    for number, paper in enumerate(papers, 1):
        lines = wrap_text(paper["title"], font, WIDTH - 2 * MARGIN - 65)
        labels = wrap_text(f"({paper['track']})", label_font, WIDTH - 2 * MARGIN - 65)
        # Include track text in the measured layout so long labels cannot clip.
        rows = [(line, False) for line in lines] + [(line, True) for line in labels]
        height = len(rows) * LINE_HEIGHT + 35
        if page and y + min(height, BOTTOM - TOP) > BOTTOM:
            pages.append(page)
            page, y = [], TOP
        while rows:
            capacity = max(1, (BOTTOM - y - 35) // LINE_HEIGHT)
            portion, rows = rows[:capacity], rows[capacity:]
            page.append((number, y, portion))
            y += len(portion) * LINE_HEIGHT + 35
            if rows:
                pages.append(page)
                page, y = [], TOP
    if page:
        pages.append(page)
    return pages


def write_images(announcements, directory):
    """Return saved paths; keep image creation independent of tweet wording."""
    if not announcements:
        return []
    try:
        from PIL import Image, ImageDraw, ImageFont, PngImagePlugin
    except ImportError as exc:
        raise ValueError("--images requires Pillow. Install it with: python3 -m pip install Pillow") from exc

    directory = Path(directory).expanduser()
    directory.mkdir(parents=True, exist_ok=True)
    title_font = load_font(ImageFont, 54, bold=True)
    font = load_font(ImageFont, 38)
    label_font = load_font(ImageFont, 27)
    saved = []
    for announcement in announcements:
        venue = announcement["venue"]
        papers = announcement["papers"]
        pages = layout_papers(papers, font, label_font)
        for index, page in enumerate(pages, 1):
            _, last_y, last_rows = page[-1]
            last_line, is_label = last_rows[-1]
            last_font = label_font if is_label else font
            content_bottom = last_y + (len(last_rows) - 1) * LINE_HEIGHT + last_font.getbbox(last_line)[3]
            height = content_bottom + MARGIN + (60 if len(pages) > 1 else 0)
            image = Image.new("RGB", (WIDTH, height), "#faf9f6")
            draw = ImageDraw.Draw(image)
            draw.rectangle((0, 0, WIDTH, 16), fill="#315e52")
            draw.text((MARGIN, 65), "ACCEPTED PAPERS", font=label_font, fill="#315e52")
            # Shrink unusually long venue names to fit the header.
            header_font = title_font
            if header_font.getlength(venue) > WIDTH - 2 * MARGIN:
                size = max(1, int(54 * (WIDTH - 2 * MARGIN) / header_font.getlength(venue)))
                header_font = load_font(ImageFont, size, bold=True)
            draw.text((MARGIN, 112), venue, font=header_font, fill="#142b26")
            for number, y, rows in page:
                draw.text((MARGIN, y), f"{number}.", font=font, fill="#315e52")
                for line, is_label in rows:
                    draw.text((MARGIN + 65, y), line,
                              font=label_font if is_label else font,
                              fill="#4c605a" if is_label else "#142b26")
                    y += LINE_HEIGHT
            if len(pages) > 1:
                draw.text((MARGIN, height - 70), f"{index}/{len(pages)}",
                          font=label_font, fill="#4c605a")
            metadata = PngImagePlugin.PngInfo()
            metadata.add_text("Description", "\n".join(
                f"{number}. " + " ".join(line for line, _ in rows)
                for number, _, rows in page
            ))
            path = directory / f"{venue.lstrip('#')}-{index}.png"
            image.save(path, pnginfo=metadata)
            saved.append(path)
    return saved
