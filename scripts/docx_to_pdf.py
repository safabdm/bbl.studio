#!/usr/bin/env python3
from pathlib import Path

import fitz
from docx import Document
from docx.oxml.ns import qn
from docx.oxml.table import CT_Tbl
from docx.oxml.text.paragraph import CT_P
from docx.table import Table
from docx.text.paragraph import Paragraph

SRC = Path("/Users/safabadamchi/Desktop/Experience/Work/BBLS/BBLS_Business_Plan_Competitive_Copy.docx")
OUT = Path("/Users/safabadamchi/Desktop/Experience/Work/BBLS/BBLS_Business_Plan_Competitive_Copy.pdf")

NAVY = (0x10 / 255, 0x18 / 255, 0x20 / 255)
BLUE = (0x2E / 255, 0x5E / 255, 0x8C / 255)
GOLD = (0xB2 / 255, 0x8A / 255, 0x55 / 255)
BODY = (0x20 / 255, 0x25 / 255, 0x2A / 255)
MUTED = (0x68 / 255, 0x70 / 255, 0x78 / 255)
WHITE = (1, 1, 1)
LINE = (0xD8 / 255, 0xDE / 255, 0xE4 / 255)
HEADER_BG = (0x10 / 255, 0x18 / 255, 0x20 / 255)

FONT = "/System/Library/Fonts/HelveticaNeue.ttc"
MEASURE = fitz.Font(fontfile=FONT)


def is_bullet(para):
    style = (para.style.name or "") if para.style else ""
    if "List" in style:
        return True
    ppr = para._p.pPr
    if ppr is None:
        return False
    numpr = ppr.find(qn("w:numPr"))
    return numpr is not None


def iter_blocks(document):
    for child in document.element.body.iterchildren():
        if isinstance(child, CT_P):
            yield Paragraph(child, document)
        elif isinstance(child, CT_Tbl):
            yield Table(child, document)


def clean(text):
    return (
        text.replace("\u2018", "'")
        .replace("\u2019", "'")
        .replace("\u201c", '"')
        .replace("\u201d", '"')
        .replace("\u2013", "-")
        .replace("\u2014", "-")
        .replace("\u00a0", " ")
    )


def wrap(text, font, size, width):
    text = clean(text)
    if not text:
        return [""]
    lines = []
    for chunk in text.split("\n"):
        words = chunk.split()
        current = ""
        if not words:
            lines.append("")
            continue
        for word in words:
            trial = word if not current else f"{current} {word}"
            if MEASURE.text_length(trial, fontsize=size) <= width:
                current = trial
            else:
                if current:
                    lines.append(current)
                current = word
        if current:
            lines.append(current)
    return lines or [""]


class PdfWriter:
    def __init__(self):
        self.doc = fitz.open()
        self.page_w = 8.5 * 72
        self.page_h = 11 * 72
        self.left = 0.85 * 72
        self.right = 0.85 * 72
        self.top = 0.8 * 72
        self.bottom = 0.85 * 72
        self.width = self.page_w - self.left - self.right
        self.page = None
        self.y = 0
        self.page_no = 0
        self.header_row = None
        self.new_page()

    def new_page(self):
        self.page = self.doc.new_page(width=self.page_w, height=self.page_h)
        self.page_no += 1
        self.y = self.top
        footer = "BBLS — Boutique Brand & Launch Studio  |  Confidential planning document"
        self.page.insert_text((self.left, self.page_h - 0.42 * 72), footer, fontsize=8, fontfile=FONT, color=MUTED)
        self.page.insert_text((self.page_w - self.right - 20, self.page_h - 0.42 * 72), str(self.page_no), fontsize=8, fontfile=FONT, color=MUTED)

    def ensure(self, height):
        if self.y + height > self.page_h - self.bottom:
            self.new_page()

    def spacer(self, h):
        self.y += h

    def text(self, text, *, size=11, color=BODY, bold=False, italic=False, space_after=8, indent=0):
        text = clean(text)
        usable = self.width - indent
        lines = wrap(text, "helv", size, usable)
        line_h = size + 4
        self.ensure(line_h * len(lines) + space_after)
        for line in lines:
            self.page.insert_text((self.left + indent, self.y + size), line, fontsize=size, fontfile=FONT, color=color)
            self.y += line_h
        self.y += space_after

    def draw_row(self, wrapped_cols, height, header=False):
        self.ensure(height + 2)
        if header is False and self.y == self.top and self.header_row:
            self.draw_row(*self.header_row, header=True)
        x = self.left
        col_w = self.width / len(wrapped_cols)
        for lines in wrapped_cols:
            rect = fitz.Rect(x, self.y, x + col_w, self.y + height)
            self.page.draw_rect(rect, color=LINE, fill=HEADER_BG if header else WHITE, width=0.6)
            ty = self.y + 8
            for line in lines:
                self.page.insert_text((x + 5, ty + 6.4), line, fontsize=7.4, fontfile=FONT, color=WHITE if header else BODY)
                ty += 10.4
            x += col_w
        self.y += height

    def table(self, rows):
        cols = len(rows[0])
        col_w = self.width / cols
        font_size = 7.4
        self.header_row = None
        for r, row in enumerate(rows):
            wrapped_cols = [wrap(cell, "helv", font_size, col_w - 10) for cell in row]
            height = max(len(lines) for lines in wrapped_cols) * 10.4 + 10
            header = r == 0
            if header:
                self.header_row = (wrapped_cols, height)
            self.draw_row(wrapped_cols, height, header=header)
        self.header_row = None
        self.y += 10


def render_paragraph(pdf, para):
    text = para.text.strip()
    if not text:
        pdf.spacer(4)
        return
    style = (para.style.name or "") if para.style else ""
    if style.startswith("Heading 1"):
        pdf.spacer(8)
        pdf.text(text, size=16, color=NAVY, bold=True, space_after=6)
    elif style.startswith("Heading 2"):
        pdf.text(text, size=12.5, color=BLUE, bold=True, space_after=5)
    elif style.startswith("Heading 3"):
        pdf.text(text, size=11.5, color=NAVY, bold=True, space_after=4)
    elif is_bullet(para):
        pdf.text(f"•  {text}", size=10.2, color=BODY, space_after=2, indent=10)
    else:
        run = para.runs[0] if para.runs else None
        size = 11
        color = BODY
        bold = False
        italic = False
        if run is not None and run.font.size:
            size = run.font.size.pt
        if run is not None and run.font.color and run.font.color.rgb:
            rgb = run.font.color.rgb
            color = (rgb[0] / 255, rgb[1] / 255, rgb[2] / 255)
        if run is not None:
            bold = bool(run.bold)
            italic = bool(run.italic)
        if size >= 30:
            pdf.text(text, size=28, color=NAVY, bold=True, space_after=2)
        elif size >= 16:
            pdf.text(text, size=size, color=color, bold=True, space_after=6)
        else:
            pdf.text(text, size=min(size, 13), color=color, bold=bold, italic=italic, space_after=6)


def build():
    source = Document(str(SRC))
    pdf = PdfWriter()
    for block in iter_blocks(source):
        if isinstance(block, Paragraph):
            render_paragraph(pdf, block)
        else:
            rows = [[cell.text.strip() for cell in row.cells] for row in block.rows]
            if rows:
                pdf.spacer(4)
                pdf.table(rows)
    pdf.doc.save(str(OUT))
    print(f"Wrote {OUT} ({pdf.page_no} pages)")


if __name__ == "__main__":
    build()
