"""Build output/doc/IRQGuard_IEEE_Project_Report.docx from the local template.

Requirements: Python 3 standard library and Graphviz `dot`. Evaluation figures
use the frozen Phase 19.5 evidence in this repository.
Run from any directory with: python3 scripts/build_project_report.py
"""
from zipfile import ZipFile, ZIP_DEFLATED
from xml.etree import ElementTree as ET
from pathlib import Path
import gzip, json, re, subprocess, struct, math

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'output/doc/IRQGuard_IEEE_Project_Report.docx'
UPLOADED_TEMPLATE = ROOT / 'conference-template-a4 (1).docx'
# If the original attachment is absent, reuse the existing DOCX's embedded
# IEEE styles/theme and replace its content; this makes reruns repeatable.
TEMPLATE = UPLOADED_TEMPLATE if UPLOADED_TEMPLATE.exists() else OUT
FIGDIR = ROOT / 'output/doc/figures'
ARCH_PNG = FIGDIR / 'irqguard-architecture.png'
EVAL_PNG = FIGDIR / 'e1000e-uncertainty-events.png'
TIME_PNG = FIGDIR / 'e1000e-analysis-time.png'
LOCK_PNG = FIGDIR / 'controlled-interrupt-lock-cycle.png'
OPS_PNG = FIGDIR / 'e1000e-lock-operations.png'
CAUSE_PNG = FIGDIR / 'e1000e-uncertainty-categories.png'
WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'
A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
CT = 'http://schemas.openxmlformats.org/package/2006/content-types'
ET.register_namespace('wp', WP)
ET.register_namespace('a', A)
ET.register_namespace('pic', PIC)
ET.register_namespace('r', R)

def render_figures():
    FIGDIR.mkdir(parents=True, exist_ok=True)
    def axis_row(labels,width):
        cell=width/len(labels)
        ticks=''.join(f'<TD ALIGN="CENTER" WIDTH="{cell:.1f}"><FONT FACE="Times New Roman" POINT-SIZE="9">{label}</FONT></TD>' for label in labels)
        return f'<TR><TD></TD><TD><TABLE BORDER="0" CELLBORDER="0" CELLSPACING="0"><TR>{ticks}</TR></TABLE></TD><TD></TD></TR>'
    architecture = r'''digraph G {
      graph [rankdir=TB, bgcolor="white", pad="0.10", nodesep="0.14", ranksep="0.30", fontname="Times New Roman", fontsize=10, labelloc="t", label="IRQGuard analysis pipeline"];
      node [shape=box, style="rounded,filled", color="#3167a6", fillcolor="#eaf3ff", fontname="Times New Roman", fontsize=8, margin="0.08,0.05"];
      edge [color="#4c6f91", arrowsize=0.65];
      source [label="C source +\nKbuild flags"]; ast [label="Clang AST / CFG\nsource provenance"]; facts [label="Calls, lock APIs,\nIRQ registrations"]; sum [label="Interprocedural\nfunction summaries"]; model [label="Lock identity +\nIRQ/context model"]; depgraph [label="Context-labelled\ndependency graph"]; check [label="Bounded cycle +\nfeasibility checks"]; reports [label="Text / JSON / DOT\nexplainable findings"];
      {rank=same; source -> ast -> facts -> sum;}
      {rank=same; model -> depgraph -> check -> reports;}
      sum -> model;
    }'''
    (FIGDIR / 'architecture.dot').write_text(architecture)
    subprocess.run(['dot','-Tpng','-Gdpi=150',str(FIGDIR/'architecture.dot'),'-o',str(ARCH_PNG)],check=True)
    raw_path=ROOT/'evaluation/baselines/phase19_5/kernel/raw-measurements.json'
    raw=json.loads(raw_path.read_text())
    fixture_path=ROOT/'evaluation/baselines/phase19_5/controlled/fixture-tests__fixtures__interrupts.c.json'
    fixture=json.loads(fixture_path.read_text())
    cycle=next(c for c in fixture['interrupt_cycles'] if c['classification']=='interrupt_preemption_candidate' and 'cross_a' in c['lock_sequence'][0])
    edges=cycle['edges']
    def short_lock(identity): return identity.rsplit(':',1)[-1].rstrip(')')
    def loc(edge,key):
        site=edge[key]['expansion']
        return f"{Path(site['file']).name}:{site['line']}"
    first,second=edges
    lock_dot=f'''digraph G {{
      graph [rankdir=LR, bgcolor="white", pad="0.18", nodesep="0.9", ranksep="0.8", fontname="Times New Roman", fontsize=11, labelloc="t", label="Controlled C fixture: {cycle['feasibility']} interrupt-aware candidate\\nNot a Linux-kernel finding or independently confirmed deadlock"];
      node [shape=box, style="rounded,filled", color="#365f86", fillcolor="#eaf2fb", fontname="Times New Roman", fontsize=11, margin="0.18,0.12"];
      edge [fontname="Times New Roman", fontsize=9, arrowsize=0.8];
      "{short_lock(first['from_lock'])}" [label="{short_lock(first['from_lock'])}\\nprocess holds lock"];
      "{short_lock(first['to_lock'])}" [label="{short_lock(first['to_lock'])}\\nhandler requests lock"];
      "{short_lock(first['from_lock'])}" -> "{short_lock(first['to_lock'])}" [color="#c2413b", fontcolor="#8f2925", penwidth=2, label="process → hard IRQ\\n{first['source_function']} → {first['target_function']}\\n{loc(first,'from_location')} → {loc(first,'to_location')}\\nrequest_irq registration: {loc(first,'registration_location')}"];
      "{short_lock(second['from_lock'])}" -> "{short_lock(second['to_lock'])}" [color="#27658d", fontcolor="#1f506f", penwidth=2, label="handler lock order\\n{second['source_function']}\\n{loc(second,'from_location')} → {loc(second,'to_location')}"];
    }}'''
    (FIGDIR/'controlled-interrupt-lock-cycle.dot').write_text(lock_dot)
    subprocess.run(['dot','-Tpng','-Gdpi=150',str(FIGDIR/'controlled-interrupt-lock-cycle.dot'),'-o',str(LOCK_PNG)],check=True)
    values=[(Path(unit['file']).name,unit['counts']['uncertainties']) for unit in raw['translation_units']]
    maxv=max(v for _,v in values)
    rows=[]
    for name,val in values:
        bw=max(3,round(val/25000*240)); rest=240-bw
        rows.append(f'<TR><TD ALIGN="LEFT" WIDTH="75"><FONT FACE="Times New Roman" POINT-SIZE="11">{name}</FONT></TD><TD><TABLE BORDER="0" CELLBORDER="0" CELLSPACING="0"><TR><TD BGCOLOR="#2878c8" WIDTH="{bw}" HEIGHT="15"></TD><TD BGCOLOR="#e7eef7" WIDTH="{rest}" HEIGHT="15"></TD></TR></TABLE></TD><TD ALIGN="RIGHT" WIDTH="58"><FONT FACE="Times New Roman" POINT-SIZE="11">{val:,}</FONT></TD></TR>')
    chart='digraph G { graph [bgcolor="white", pad="0.10", fontname="Times New Roman", fontsize=12, labelloc="t", label="Uncertainty events by analyzed Linux v6.6.87 file"]; node [shape=plaintext]; chart [label=< <TABLE BORDER="0" CELLBORDER="0" CELLSPACING="6">'+''.join(rows)+axis_row(['0','5k','10k','15k','20k','25k'],240)+'</TABLE> >]; }'
    (FIGDIR / 'e1000e-uncertainty-events.dot').write_text(chart)
    subprocess.run(['dot','-Tpng','-Gdpi=150',str(FIGDIR/'e1000e-uncertainty-events.dot'),'-o',str(EVAL_PNG)],check=True)
    times=[(Path(unit['file']).name,unit['elapsed_seconds']) for unit in raw['translation_units']]
    maxt=max(v for _,v in times)
    time_axis_max=max(0.5, math.ceil(maxt*2)/2)
    timerows=[]
    for name,val in times:
        bw=max(3,round(val/time_axis_max*240)); rest=240-bw
        timerows.append(f'<TR><TD ALIGN="LEFT" WIDTH="75"><FONT FACE="Times New Roman" POINT-SIZE="11">{name}</FONT></TD><TD><TABLE BORDER="0" CELLBORDER="0" CELLSPACING="0"><TR><TD BGCOLOR="#4d78a8" WIDTH="{bw}" HEIGHT="15"></TD><TD BGCOLOR="#e7eef7" WIDTH="{rest}" HEIGHT="15"></TD></TR></TABLE></TD><TD ALIGN="RIGHT" WIDTH="58"><FONT FACE="Times New Roman" POINT-SIZE="11">{val:.3f} s</FONT></TD></TR>')
    time_ticks=[f'{time_axis_max*i/5:g}' for i in range(6)]
    time_ticks[-1]+=' s'
    timechart='digraph G { graph [bgcolor="white", pad="0.10", fontname="Times New Roman", fontsize=12, labelloc="t", label="Analysis time per Linux v6.6.87 translation unit"]; node [shape=plaintext]; chart [label=< <TABLE BORDER="0" CELLBORDER="0" CELLSPACING="6">'+''.join(timerows)+axis_row(time_ticks,240)+'</TABLE> >]; }'
    (FIGDIR / 'e1000e-analysis-time.dot').write_text(timechart)
    subprocess.run(['dot','-Tpng','-Gdpi=150',str(FIGDIR/'e1000e-analysis-time.dot'),'-o',str(TIME_PNG)],check=True)
    operations=[(Path(u['file']).name,u['counts']['lock_acquisitions'],u['counts']['lock_releases']) for u in raw['translation_units']]
    opmax=max(1,max(a+r for _,a,r in operations)); oprows=[]
    for name,acq,rel in operations:
        bw=round(220*acq/10); rw=round(220*rel/10); rest=220-bw-rw
        # Graphviz assigns a default width to empty cells; omit zero-valued
        # segments so a 0/0 row cannot look like it contains operations.
        segments=''.join(f'<TD BGCOLOR="{color}" WIDTH="{width}" HEIGHT="15"></TD>' for color,width in [('#2878c8',bw),('#df8b36',rw)] if width > 0)
        segments+=f'<TD BGCOLOR="#e7eef7" WIDTH="{rest}" HEIGHT="15"></TD>'
        oprows.append(f'<TR><TD ALIGN="LEFT" WIDTH="75"><FONT FACE="Times New Roman" POINT-SIZE="11">{name}</FONT></TD><TD><TABLE BORDER="0" CELLBORDER="0" CELLSPACING="0"><TR>{segments}</TR></TABLE></TD><TD ALIGN="RIGHT" WIDTH="62"><FONT FACE="Times New Roman" POINT-SIZE="11">{acq} / {rel}</FONT></TD></TR>')
    opslegend='<TR><TD></TD><TD COLSPAN="2"><FONT FACE="Times New Roman" POINT-SIZE="10"><FONT COLOR="#2878c8">■</FONT> acquisitions     <FONT COLOR="#df8b36">■</FONT> releases</FONT></TD></TR>'
    opschart='digraph G { graph [bgcolor="white", pad="0.10", fontname="Times New Roman", fontsize=12, labelloc="t", label="Lock API operations per translation unit (acquire / release)"]; node [shape=plaintext]; chart [label=< <TABLE BORDER="0" CELLBORDER="0" CELLSPACING="6">'+''.join(oprows)+axis_row(['0','2','4','6','8','10 ops'],220)+opslegend+'</TABLE> >]; }'
    (FIGDIR/'e1000e-lock-operations.dot').write_text(opschart)
    subprocess.run(['dot','-Tpng','-Gdpi=150',str(FIGDIR/'e1000e-lock-operations.dot'),'-o',str(OPS_PNG)],check=True)
    summary={}
    for unit in raw['translation_units']:
        report=json.loads((ROOT/'evaluation/baselines/phase19_5/kernel'/unit['report_path']).read_text())
        for category,data in report.get('uncertainty_summary',{}).get('by_category',{}).items():
            summary[category]=summary.get(category,0)+data['event_count']
    cause_values=list(summary.items())
    cause_values.sort(key=lambda item:item[1],reverse=True); causemax=max(v for _,v in cause_values); causerows=[]
    for name,val in cause_values:
        bw=max(3,round(val/20000*240)); rest=240-bw
        color='#d8862f' if name=='interrupt_state' else '#2878c8'
        causerows.append(f'<TR><TD ALIGN="LEFT" WIDTH="105"><FONT FACE="Times New Roman" POINT-SIZE="10">{name}</FONT></TD><TD><TABLE BORDER="0" CELLBORDER="0" CELLSPACING="0"><TR><TD BGCOLOR="{color}" WIDTH="{bw}" HEIGHT="14"></TD><TD BGCOLOR="#e7eef7" WIDTH="{rest}" HEIGHT="14"></TD></TR></TABLE></TD><TD ALIGN="RIGHT" WIDTH="58"><FONT FACE="Times New Roman" POINT-SIZE="10">{val:,}</FONT></TD></TR>')
    causechart='digraph G { graph [bgcolor="white", pad="0.10", fontname="Times New Roman", fontsize=12, labelloc="t", label="Uncertainty events by classified category"]; node [shape=plaintext]; chart [label=< <TABLE BORDER="0" CELLBORDER="0" CELLSPACING="5">'+''.join(causerows)+axis_row(['0','5k','10k','15k','20k'],240)+'</TABLE> >]; }'
    (FIGDIR/'e1000e-uncertainty-categories.dot').write_text(causechart)
    subprocess.run(['dot','-Tpng','-Gdpi=150',str(FIGDIR/'e1000e-uncertainty-categories.dot'),'-o',str(CAUSE_PNG)],check=True)

render_figures()
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
XML = 'http://www.w3.org/XML/1998/namespace'
NS = {'w': W}
def q(local): return f'{{{W}}}{local}'

# The uploaded conference template is ISO Strict OOXML. Normalize its package
# namespaces to the Transitional OOXML profile used by widely deployed DOCX
# parsers (including python-docx) before editing, and emit Transitional parts.
STRICT_TO_TRANSITIONAL = {
    'http://purl.oclc.org/ooxml/wordprocessingml/main': W,
    'http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing': WP,
    'http://purl.oclc.org/ooxml/drawingml/main': A,
    'http://purl.oclc.org/ooxml/drawingml/picture': PIC,
    'http://purl.oclc.org/ooxml/officeDocument/relationships': R,
    'http://purl.oclc.org/ooxml/officeDocument/extendedProperties': 'http://schemas.openxmlformats.org/officeDocument/2006/extendedProperties',
    'http://purl.oclc.org/ooxml/officeDocument/docPropsVTypes': 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes',
    'http://purl.oclc.org/ooxml/officeDocument/math': 'http://schemas.openxmlformats.org/officeDocument/2006/math',
    'http://purl.oclc.org/ooxml/officeDocument/customXml': 'http://schemas.openxmlformats.org/officeDocument/2006/customXml',
}
def normalize_ooxml_part(data):
    for strict_uri, transitional_uri in STRICT_TO_TRANSITIONAL.items():
        data = data.replace(strict_uri.encode(), transitional_uri.encode())
    return data.replace(b' w:conformance="strict"', b'')

def image_paragraph(path, rid, name, width_emu, description=None):
    with open(path,'rb') as img: header=img.read(24)
    iw,ih=struct.unpack('>II',header[16:24]); height_emu=int(width_emu*ih/iw)
    p=ET.Element(q('p')); ppr=ET.SubElement(p,q('pPr')); ps=ET.SubElement(ppr,q('pStyle')); ps.set(q('val'),'BodyText'); jc=ET.SubElement(ppr,q('jc')); jc.set(q('val'),'center')
    ET.SubElement(ppr,q('keepNext')); ET.SubElement(ppr,q('keepLines'))
    run=ET.SubElement(p,q('r')); drawing=ET.SubElement(run,q('drawing')); inline=ET.SubElement(drawing,f'{{{WP}}}inline',{'distT':'0','distB':'0','distL':'0','distR':'0'})
    image_id=rid.removeprefix('rId')
    ET.SubElement(inline,f'{{{WP}}}extent',{'cx':str(width_emu),'cy':str(height_emu)}); ET.SubElement(inline,f'{{{WP}}}docPr',{'id':image_id,'name':name,'descr':description or name})
    frame=ET.SubElement(inline,f'{{{WP}}}cNvGraphicFramePr'); locks=ET.SubElement(frame,f'{{{A}}}graphicFrameLocks'); locks.set('noChangeAspect','1')
    graphic=ET.SubElement(inline,f'{{{A}}}graphic'); gd=ET.SubElement(graphic,f'{{{A}}}graphicData',{'uri':PIC}); pic=ET.SubElement(gd,f'{{{PIC}}}pic')
    nv=ET.SubElement(pic,f'{{{PIC}}}nvPicPr'); ET.SubElement(nv,f'{{{PIC}}}cNvPr',{'id':image_id,'name':path.name}); ET.SubElement(nv,f'{{{PIC}}}cNvPicPr')
    fill=ET.SubElement(pic,f'{{{PIC}}}blipFill'); ET.SubElement(fill,f'{{{A}}}blip',{f'{{{R}}}embed':rid}); stretch=ET.SubElement(fill,f'{{{A}}}stretch'); ET.SubElement(stretch,f'{{{A}}}fillRect')
    sp=ET.SubElement(pic,f'{{{PIC}}}spPr'); xf=ET.SubElement(sp,f'{{{A}}}xfrm'); ET.SubElement(xf,f'{{{A}}}off',{'x':'0','y':'0'}); ET.SubElement(xf,f'{{{A}}}ext',{'cx':str(width_emu),'cy':str(height_emu)}); geom=ET.SubElement(sp,f'{{{A}}}prstGeom',{'prst':'rect'}); ET.SubElement(geom,f'{{{A}}}avLst')
    return p

def algorithm_table(title, lines, code=False):
    tbl=ET.Element(q('tbl')); pr=ET.SubElement(tbl,q('tblPr')); width=ET.SubElement(pr,q('tblW')); width.set(q('w'),'4860'); width.set(q('type'),'dxa'); layout=ET.SubElement(pr,q('tblLayout')); layout.set(q('type'),'fixed')
    borders=ET.SubElement(pr,q('tblBorders'))
    for edge in ('top','bottom'):
        e=ET.SubElement(borders,q(edge)); e.set(q('val'),'single'); e.set(q('sz'),'8'); e.set(q('space'),'0'); e.set(q('color'),'424242')
    for edge in ('left','right','insideH','insideV'):
        e=ET.SubElement(borders,q(edge)); e.set(q('val'),'nil')
    mar=ET.SubElement(pr,q('tblCellMar'))
    for edge,val in [('top','30'),('bottom','30'),('start','65'),('end','65')]:
        el=ET.SubElement(mar,q(edge)); el.set(q('w'),val); el.set(q('type'),'dxa')
    grid=ET.SubElement(tbl,q('tblGrid'))
    for val in ('420','4440'):
        el=ET.SubElement(grid,q('gridCol')); el.set(q('w'),val)
    header=ET.SubElement(tbl,q('tr')); hcell=ET.SubElement(header,q('tc')); hpr=ET.SubElement(hcell,q('tcPr')); span=ET.SubElement(hpr,q('gridSpan')); span.set(q('val'),'2'); hwidth=ET.SubElement(hpr,q('tcW')); hwidth.set(q('w'),'4860'); hwidth.set(q('type'),'dxa')
    hp=ET.SubElement(hcell,q('p')); hppr=ET.SubElement(hp,q('pPr')); hspacing=ET.SubElement(hppr,q('spacing')); hspacing.set(q('before'),'0'); hspacing.set(q('after'),'0')
    pbdr=ET.SubElement(hppr,q('pBdr')); hb=ET.SubElement(pbdr,q('bottom')); hb.set(q('val'),'single'); hb.set(q('sz'),'5'); hb.set(q('space'),'3'); hb.set(q('color'),'777777')
    label=re.match(r'^(Algorithm|Listing)\s+\d+\.?',title).group(0)
    description=title[len(label):].strip()
    for text,bold,italic in ((label+' ',True,False),(description,False,True)):
        run=ET.SubElement(hp,q('r')); rp=ET.SubElement(run,q('rPr')); fonts=ET.SubElement(rp,q('rFonts')); fonts.set(q('ascii'),'Times New Roman'); fonts.set(q('hAnsi'),'Times New Roman')
        if bold: ET.SubElement(rp,q('b'))
        if italic: ET.SubElement(rp,q('i'))
        size=ET.SubElement(rp,q('sz')); size.set(q('val'),'20'); t=ET.SubElement(run,q('t')); t.set(f'{{{XML}}}space','preserve'); t.text=text
    keywords=('procedure','for each','while','if','then','else','return','end if','end for','end while','continue','do')
    keyword_pattern=r'\b('+'|'.join(re.escape(k) for k in sorted(keywords,key=len,reverse=True))+r')\b'
    for i,(indent,line) in enumerate(lines,1):
        tr=ET.SubElement(tbl,q('tr'))
        for value,is_code,width_value in ((f'{i}:',False,'420'),(line,True,'4440')):
            tc=ET.SubElement(tr,q('tc')); tcpr=ET.SubElement(tc,q('tcPr')); tcw=ET.SubElement(tcpr,q('tcW')); tcw.set(q('w'),width_value); tcw.set(q('type'),'dxa')
            p=ET.SubElement(tc,q('p')); ppr=ET.SubElement(p,q('pPr')); spacing=ET.SubElement(ppr,q('spacing')); spacing.set(q('before'),'0'); spacing.set(q('after'),'0'); spacing.set(q('line'),'240'); spacing.set(q('lineRule'),'exact')
            ET.SubElement(ppr,q('jc'),{q('val'):'right' if not is_code else 'left'})
            if is_code:
                ind=ET.SubElement(ppr,q('ind')); ind.set(q('left'),str(indent*220))
            if is_code:
                parts=re.split(keyword_pattern,value)
            else: parts=[value]
            for part in parts:
                if not part: continue
                font='Courier New' if code and is_code else 'Times New Roman'
                run=ET.SubElement(p,q('r')); rp=ET.SubElement(run,q('rPr')); fonts=ET.SubElement(rp,q('rFonts')); fonts.set(q('ascii'),font); fonts.set(q('hAnsi'),font); size=ET.SubElement(rp,q('sz')); size.set(q('val'),'18' if code and is_code else ('20' if is_code else '18'))
                if is_code and not code and part in keywords: ET.SubElement(rp,q('b'))
                t=ET.SubElement(run,q('t')); t.set(f'{{{XML}}}space','preserve'); t.text=part
    return tbl

with ZipFile(TEMPLATE) as zin:
    entries = [(item, normalize_ooxml_part(zin.read(item.filename))) for item in zin.infolist()]
    doc_bytes = next(data for item,data in entries if item.filename=='word/document.xml')
    ns_pairs = []
    for _, pair in ET.iterparse(__import__('io').BytesIO(doc_bytes), events=('start-ns',)):
        if pair not in ns_pairs: ns_pairs.append(pair)
    for prefix, uri in ns_pairs:
        ET.register_namespace(prefix or '', uri)
    root = ET.fromstring(doc_bytes)
    body = root.find('w:body', NS)
    children = list(body)
    paras = [c for c in children if c.tag == q('p')]
    # Discover section anchors in either the uploaded template or a previously
    # generated report rather than relying on brittle paragraph offsets.
    title = next(p for p in paras if p.find('w:pPr/w:pStyle',NS) is not None and
                 p.find('w:pPr/w:pStyle',NS).get(q('val'))=='papertitle')
    section_paragraphs=[p for p in paras if p.find('w:pPr/w:sectPr',NS) is not None]
    first_section_break=section_paragraphs[0]
    final_section_break=section_paragraphs[-1]
    author_breaks=section_paragraphs[1:-1]
    root_section = children[-1]

    def set_text(p, text):
        ppr = p.find('w:pPr', NS)
        for ch in list(p):
            if ch is not ppr: p.remove(ch)
        run = ET.SubElement(p, q('r'))
        t = ET.SubElement(run, q('t'))
        if text[:1].isspace() or text[-1:].isspace(): t.set(f'{{{XML}}}space', 'preserve')
        t.text = text
        return p

    def paragraph(text, style='BodyText'):
        p = ET.Element(q('p'))
        ppr = ET.SubElement(p, q('pPr'))
        st = ET.SubElement(ppr, q('pStyle'))
        st.set(q('val'), style)
        if style == 'references':
            ET.SubElement(ppr,q('keepLines'))
            ET.SubElement(ppr,q('jc'),{q('val'):'left'})
            ET.SubElement(ppr,q('ind'),{q('left'):'300',q('hanging'):'300'})
            spacing=ET.SubElement(ppr,q('spacing'))
            spacing.set(q('before'),'0'); spacing.set(q('after'),'80')
            spacing.set(q('line'),'240'); spacing.set(q('lineRule'),'exact')
        if text:
            run = ET.SubElement(p, q('r'))
            t = ET.SubElement(run, q('t'))
            if text[:1].isspace() or text[-1:].isspace(): t.set(f'{{{XML}}}space', 'preserve')
            t.text = text
        return p

    def set_columns(section_paragraph, count):
        sect = section_paragraph.find('w:pPr/w:sectPr', NS)
        cols = sect.find('w:cols', NS) if sect is not None else None
        if cols is not None:
            cols.set(q('num'), str(count))

    # Compact IEEE title block with two student authors and their advisor.
    set_columns(author_breaks[0], 1)
    set_columns(author_breaks[1], 1)
    title = set_text(title, 'IRQGuard: Toward Static Detection of Interrupt-Induced Deadlocks in Linux Kernel Code')
    for section_break in author_breaks:
        set_columns(section_break, 1)
        # The template's sample has a forced column break after the author
        # area. In a one-column title section it creates a large blank gap.
        for parent in section_break.iter():
            for child in list(parent):
                if child.tag == q('br') and child.get(q('type')) == 'column':
                    parent.remove(child)
    final_section_break = set_text(final_section_break, '')
    # The template's final section anchor can inherit a bibliography paragraph
    # style. Keep the section boundary but remove that style from its empty mark.
    final_ppr=final_section_break.find('w:pPr',NS)
    if final_ppr is not None:
        final_style=final_ppr.find('w:pStyle',NS)
        if final_style is not None and final_style.get(q('val'))=='references':
            final_ppr.remove(final_style)
    author = ET.Element(q('tbl'))
    atpr=ET.SubElement(author,q('tblPr')); atw=ET.SubElement(atpr,q('tblW')); atw.set(q('w'),'10120'); atw.set(q('type'),'dxa')
    alayout=ET.SubElement(atpr,q('tblLayout')); alayout.set(q('type'),'fixed')
    aborders=ET.SubElement(atpr,q('tblBorders'))
    for edge in ('top','left','bottom','right','insideH','insideV'):
        e=ET.SubElement(aborders,q(edge)); e.set(q('val'),'nil')
    ag=ET.SubElement(author,q('tblGrid'))
    for width in ('3373','3374','3373'):
        c=ET.SubElement(ag,q('gridCol')); c.set(q('w'),width)
    tr=ET.SubElement(author,q('tr'))
    author_items=[('M Hanuma Sathvik','Roll No. 124CS0084'),
                  ('Dr. N. Srinivas Naik, Ph.D.','Associate Professor (Guided by)'),
                  ('M Sai','Roll No. 524CS0002')]
    for name,detail in author_items:
        tc=ET.SubElement(tr,q('tc')); tcpr=ET.SubElement(tc,q('tcPr')); tcw=ET.SubElement(tcpr,q('tcW')); tcw.set(q('w'),'3373'); tcw.set(q('type'),'dxa')
        for content_text,style_name in ((name,'Author'),(detail,'Affiliation')):
            p=ET.SubElement(tc,q('p')); ppr=ET.SubElement(p,q('pPr')); jc=ET.SubElement(ppr,q('jc')); jc.set(q('val'),'center'); ps=ET.SubElement(ppr,q('pStyle')); ps.set(q('val'),style_name)
            spacing=ET.SubElement(ppr,q('spacing')); spacing.set(q('before'),'0'); spacing.set(q('after'),'0')
            run=ET.SubElement(p,q('r')); t=ET.SubElement(run,q('t')); t.text=content_text
    affiliation = paragraph('Department of Computer Science and Engineering, IIITDM Kurnool, Kurnool, India', 'Affiliation')
    affiliation.find('w:pPr',NS).append(ET.Element(q('jc'),{q('val'):'center'}))

    raw_eval=json.loads((ROOT/'evaluation/baselines/phase19_5/kernel/raw-measurements.json').read_text())
    fixture_eval=json.loads((ROOT/'evaluation/baselines/phase19_5/controlled/summary.json').read_text())
    kernel_counts=raw_eval['aggregate']['counts_sum_across_translation_units']
    kernel_reports=[json.loads((ROOT/'evaluation/baselines/phase19_5/kernel'/unit['report_path']).read_text()) for unit in raw_eval['translation_units']]
    uncertainty_events=sum(r.get('uncertainty_summary',{}).get('event_count',0) for r in kernel_reports)
    uncertainty_records=sum(r.get('uncertainty_summary',{}).get('unique_record_count',0) for r in kernel_reports)
    uncertainty_roots=sum(r.get('uncertainty_summary',{}).get('unique_root_cause_count',0) for r in kernel_reports)
    uncertainty_propagated=sum(r.get('uncertainty_summary',{}).get('propagated_event_count',0) for r in kernel_reports)
    registration_count=sum(len(r.get('interrupt_registrations',[])) for r in kernel_reports)
    call_count=sum(len(r.get('calls',[])) for r in kernel_reports)
    diagnostic_text='; '.join(str(d.get('message','') if isinstance(d,dict) else d)
                              for r in kernel_reports for d in r.get('diagnostics',[]))
    kernel_seconds=raw_eval['aggregate']['analysis_elapsed_seconds_sum']
    kernel_peak=raw_eval['aggregate']['peak_rss_kib_max_across_separate_runs']
    content = []
    abstract=(f'Abstract—Interrupt-induced deadlocks can occur when a hardware interrupt preempts kernel code holding a lock and the handler attempts to acquire a conflicting lock. This report presents IRQGuard, an undergraduate research prototype for scoped static analysis of Linux-style C source. The tool uses Clang AST and control-flow information to extract calls, supported lock operations, interrupt registrations, symbolic lock identities, and source locations. It propagates selected effects through function summaries, builds process and hard-IRQ dependency graphs, and applies bounded feasibility checks. A separate pthread harness compares static predictions with structured userspace traces but does not emulate hardware interrupts. {fixture_eval["controlled_fixture_passed"]} of {fixture_eval["controlled_fixture_passed"] + fixture_eval["controlled_fixture_failed"]} controlled evaluation assertions passed. A pinned Linux v6.6.87 analysis of five e1000e translation units extracted {kernel_counts["functions"]} functions and {kernel_counts["lock_operations"]} lock operations but produced no dependency edges or cycle findings; it recorded {uncertainty_events:,} uncertainty events, {uncertainty_roots:,} root causes and {kernel_counts["diagnostics"]} parser or control-flow diagnostics. A historical MIPS GIC case is a partial match, while an 8250 serial lock-order case is missed. These results demonstrate functioning extraction and case-specific behavior, not kernel-wide detection accuracy, soundness, or deadlock freedom.')
    content.append(paragraph(abstract, 'Abstract'))
    content.append(paragraph('Keywords—Linux kernel, static analysis, lock dependency, interrupt preemption, deadlock analysis', 'Keywords'))

    def h1(text): content.append(paragraph(text, 'Heading1'))
    def h2(text): content.append(paragraph(text, 'Heading2'))
    def bodytext(text): content.append(paragraph(text, 'BodyText'))
    def bullet(text): content.append(paragraph(text, 'bulletlist'))

    h1('I. INTRODUCTION')
    bodytext('A lock-order cycle is a necessary warning sign for many deadlocks, but kernel interrupt preemption adds an asymmetric execution edge. A task can hold one lock and be interrupted before reaching its release; the hard-IRQ handler then runs on the same CPU and may request a lock that the interrupted path already holds. A useful analysis must combine ordinary lock ordering with interrupt context and local interrupt state. The USENIX Security 2024 paper by Ye, Cai, and Zhang introduced Archerfish and an Interrupt-Aware Lock Graph (ILG) for this problem [1].')
    bodytext('IRQGuard is a continuing undergraduate systems project that applies a scoped subset of these ideas. Its purpose is to inspect actual C translation units with Clang, retain source evidence, and report candidate dependencies with uncertainty rather than assert that every graph cycle is a deadlock. The project includes a command-line analyzer, an optional local web interface, controlled fixtures, a userspace runtime-evidence harness, and bounded Linux source evaluations.')
    bodytext('The report makes four contributions. First, it describes a real-source Clang AST and control-flow extraction pipeline. Second, it documents interprocedural lock summaries, selected interrupt-state semantics, symbolic lock identities, and bounded cycle feasibility checks. Third, it reports controlled and real-source measurements with their limitations. Finally, it compares IRQGuard with Archerfish without claiming equivalence or reproducing the paper\'s kernel-scale results.')

    h1('II. RESEARCH CONTEXT AND SCOPE')
    h2('A. Archerfish and interrupt-aware analysis')
    bodytext('Archerfish analyzes LLVM IR and combines interrupt-handler identification, summary-based lockset and interrupt-state analysis, preemption-point clustering, ILG construction, and lazy cycle validation. Its handler specifications include manually modeled APIs and LLM-assisted specifications. Its feasibility stage checks interrupt registration ordering and path conditions after cycle discovery [1]. The paper evaluates Linux v6.4 at kernel scale and reports results substantially beyond this project\'s scope.')
    h2('B. What IRQGuard implements')
    bodytext('IRQGuard is independently implemented in C++17 using Clang LibTooling and LLVM/Clang AST and CFG interfaces [6], [9]. It analyzes one translation unit per invocation with caller-supplied compiler arguments or a compilation database. The frontend records function definitions, direct calls, selected API operations, macro spelling and expansion locations, control constructs, and parser diagnostics. The subsequent pipeline builds interprocedural summaries, propagates supported lock effects, models selected process and hard-IRQ relationships, searches a context-labelled dependency graph, and applies bounded feasibility checks.')
    bodytext('The analyzer has a configurable API registry. Its built-in subset includes mutex and spinlock acquire/release calls, spin_lock_irq and irqsave/irqrestore variants, bottom-half lock calls, local IRQ state changes, and request_irq/free_irq registration evidence. These APIs are not treated as semantically interchangeable. In particular, irqrestore uses its saved flags relationship; it is not an unconditional interrupt enable, consistent with Linux locking guidance [7], [8]. Unknown APIs, unresolved handler targets, ambiguous lock expressions, and incomplete summaries remain visible as uncertainty.')
    content.append(paragraph('TABLE I. MODELED LOCK AND INTERRUPT OPERATIONS', 'tablehead'))
    api_table=ET.Element(q('tbl')); apr=ET.SubElement(api_table,q('tblPr')); aw=ET.SubElement(apr,q('tblW')); aw.set(q('w'),'4860'); aw.set(q('type'),'dxa'); al=ET.SubElement(apr,q('tblLayout')); al.set(q('type'),'fixed')
    ab=ET.SubElement(apr,q('tblBorders'))
    for edge in ('top','left','bottom','right','insideH','insideV'):
        e=ET.SubElement(ab,q(edge)); e.set(q('val'),'nil' if edge in ('left','right','insideV') else 'single'); e.set(q('sz'),'7' if edge in ('top','bottom') else '4'); e.set(q('space'),'0'); e.set(q('color'),'777777')
    ag=ET.SubElement(api_table,q('tblGrid'))
    for w in ('1570','3290'):
        col=ET.SubElement(ag,q('gridCol')); col.set(q('w'),w)
    api_rows=[('API family','Modeled facts and limits'),
              ('mutex_lock / unlock','Lock acquire and release; no modeled IRQ-state transition.'),
              ('spin_lock / unlock','Lock acquire and release; execution context comes from the analyzed caller.'),
              ('spin_lock_irq / unlock_irq','Lock operation plus local IRQ disabled/enabled state in the current abstraction.'),
              ('spin_lock_irqsave / irqrestore','Lock operation plus saved-state association; unresolved flags make IRQ state unknown.'),
              ('spin_lock_bh / unlock_bh','Lock operation plus softirq disable/enable effect; softirq execution is not a fully modeled context.'),
              ('local_irq_disable / enable','IRQ-state transition only; not represented as a lock acquisition.'),
              ('request_irq / free_irq','Handler registration evidence; teardown lifecycle remains uncertain.')]
    for ri,rowdata in enumerate(api_rows):
        tr=ET.SubElement(api_table,q('tr'))
        for ci,value in enumerate(rowdata):
            tc=ET.SubElement(tr,q('tc')); tcpr=ET.SubElement(tc,q('tcPr')); tcw=ET.SubElement(tcpr,q('tcW')); tcw.set(q('w'),('1570','3290')[ci]); tcw.set(q('type'),'dxa')
            p=ET.SubElement(tc,q('p')); ppr=ET.SubElement(p,q('pPr')); ps=ET.SubElement(ppr,q('pStyle')); ps.set(q('val'),'tablehead' if ri==0 else 'tablecopy')
            run=ET.SubElement(p,q('r')); t=ET.SubElement(run,q('t')); t.text=value
    content.append(api_table)
    h2('C. Deliberate non-goals')
    bodytext('IRQGuard is not a full-kernel analyzer, a kernel build system, a formal verification tool, or a replacement for lockdep. It does not claim whole-program soundness or completeness. It does not automatically confirm a kernel deadlock, and userspace traces do not emulate hardware interrupts. Current context modeling centers on process and hard IRQ; softirq and NMI behavior, many subsystem callback registrations, general pointer aliasing, complete CPU-hotplug semantics, and arbitrary path conditions are outside the implemented subset.')

    h1('III. ARCHITECTURE AND IMPLEMENTATION')
    bodytext('The command-line pipeline is: C source plus build flags -> Clang AST and CFG extraction -> API and symbolic identity facts -> interprocedural summaries -> IRQ-state and context analysis -> dependency graph and bounded cycle checks -> text, JSON, or Graphviz output. A local Node.js backend can invoke fixed project tools and store reports; the React interface consumes those reports. The graphical interface is optional; the CLI is the primary interface.')
    content.extend([paragraph('FIGURE 1. IRQGUARD ANALYSIS PIPELINE', 'figurecaption'), image_paragraph(ARCH_PNG, 'rId13', 'IRQGuard analysis pipeline', 3000000), paragraph('The pipeline preserves source provenance and reports uncertainty at each stage; graph cycles remain candidates pending feasibility and independent evidence.', 'figurecaption')])
    h2('A. Frontend and provenance')
    bodytext('A Clang frontend action traverses actual function declarations and call expressions. Function and call records preserve names, caller context, and source coordinates. Lock API recognition uses the configured registry and macro-aware source locations, retaining expansion and spelling coordinates where Clang exposes them. Conditional and loop constructs feed later control-flow reasoning. Parse errors and diagnostics are reported rather than converted into successful analyses.')
    content.append(algorithm_table('Algorithm 1. Interrupt-aware cycle search', [
        (0,'procedure SEARCH_HANDLER_EDGE(e, H)'),
        (1,'h ← e.handler; path ← [e]; visited ← {e.to_lock}'),
        (1,'procedure DFS(lock)'),
        (2,'if length(path) ≥ 24 or findings ≥ 256 then return'),
        (2,'for each hard-IRQ edge f from lock in handler h do'),
        (3,'if f.to_lock = e.from_lock then'),
        (4,'emit cycle(path followed by f) with edge provenance'),
        (3,'else if f.to_lock ∉ visited then'),
        (4,'add f.to_lock to visited; append f to path'),
        (4,'DFS(f.to_lock)'),
        (4,'remove f from path; remove f.to_lock from visited'),
        (3,'end if'),
        (2,'end for'),
        (1,'end procedure'),
        (1,'DFS(e.to_lock)'),
        (0,'end procedure'),
    ]))
    content.append(paragraph('Simplified pseudocode of the bounded same-handler search in src/InterruptAnalysis.cpp. Cycle candidates are subsequently classified using edge feasibility, IRQ state, and registration evidence. Limits: depth 24 and at most 256 findings.', 'figurecaption'))
    bodytext('Algorithm 1 starts from a modeled process-to-hard-IRQ dependency and follows handler edges that can close a path back to the original source lock. The visited-lock set prevents revisiting a lock on the current search path; the depth and finding limits bound the emitted search work. These bounds are operational limits, not a proof that unexplored paths are safe. If a limit prevents examining a path, the analysis must retain that coverage limitation.')
    bodytext('Each emitted cycle is a graph witness assembled from edges with their own provenance. The edge sequence records lock identities, functions, source sites, and resolved registration evidence when available. It does not by itself establish that all edge-producing operations are reachable on one compatible execution. Algorithm 2 therefore considers a narrower question: whether a direct dependency has a compatible path in the available function CFG. Cross-function predicate conjunction, general symbolic execution, and complete handler lifecycle reasoning remain outside this refinement.')
    content.append(algorithm_table('Algorithm 2. Direct dependency path refinement', [
        (0,'procedure REFINE_DIRECT_EDGE(e)'),
        (1,'if CFG is missing or incomplete then return INCONCLUSIVE'),
        (1,'Q ← {entry state}; compatible ← false; unknown ← false'),
        (1,'while Q is not empty and states < 2,048 do'),
        (2,'s ← remove one state from Q'),
        (2,'if target acquisition is reached while source lock is held then'),
        (3,'record a compatible or unknown path witness'),
        (2,'end if'),
        (2,'for each CFG successor s′ do'),
        (3,'if a supported guard contradicts s.predicates then continue'),
        (3,'if edge is a loop-back then clear predicates; mark unknown'),
        (3,'enqueue s′ with updated lock-held and guard state'),
        (2,'end for'),
        (1,'end while'),
        (1,'return REACHABLE, INCONCLUSIVE, or REJECTED with reason'),
        (0,'end procedure'),
    ]))
    content.append(paragraph('Simplified pseudocode of direct same-function CFG refinement. It does not conjoin predicates across distinct lock-order edges and does not model general symbolic execution.', 'figurecaption'))
    content.append(algorithm_table('Listing 1. C source excerpt: saved IRQ-state pairing', [
        (0,'void irqsave_restore_cases(void) {'),
        (1,'unsigned long flags = 0;'),
        (1,'spin_lock_irqsave(&state_a, &flags);'),
        (1,'spin_lock(&state_b);'),
        (1,'spin_unlock(&state_b);'),
        (1,'spin_unlock_irqrestore(&state_a, &flags);'),
        (0,'}'),
    ], code=True))
    content.append(paragraph('Source: tests/fixtures/interrupts.c. irqrestore is tied to the saved flags value; it is not represented as an unconditional enable.', 'figurecaption'))
    h2('B. Lock identity and summaries')
    bodytext('Lock expressions are represented as symbolic templates based on declarations, members, array indices, parameters, and supported aliases. Distinct declarations are not merged solely because their names or types resemble one another. Function summaries record acquisitions, releases, dependencies, and selected IRQ effects; call-site substitution preserves argument-dependent identities where it can. Recursion uses bounded summary propagation. Missing bodies, unresolved indirect calls, ambiguous aliases, and unsupported effects reduce the conclusion and are explicitly surfaced.')
    bodytext('A narrow extension recognizes selected per-CPU forms. Exact per_cpu and this_cpu_ptr AST evidence can produce a storage-plus-index symbolic identity. Supported current-CPU and literal-index cases are kept distinct; unresolved or computed indices are not guessed. The controlled per-CPU identity fixture checks that supported expressions normalize consistently while distinct literal CPU indices remain distinct. This is a symbolic source-level identity abstraction, not proof that the operations execute on the same CPU or overlap. General migration, hotplug, alias, and callback semantics remain outside the model.')
    h2('C. Interrupt context and cycle refinement')
    bodytext('Statically resolved request_irq targets provide hard-IRQ registration evidence. The analysis tracks selected local interrupt disable, enable, save, and restore transitions. Context-labelled graph edges distinguish regular process ordering from modeled interrupt-preemption ordering. A bounded depth-first search reconstructs candidate cycles and provenance. The feasibility layer supports limited CFG guard reasoning for simple branches and selected IRQ constraints; unknown conditions or incomplete summaries leave a result inconclusive. No statistical risk or confidence probability is assigned.')
    h2('D. Reports and runtime evidence')
    bodytext('The CLI emits readable text, versioned JSON, and DOT graph output. Reports contain source sites, lock identities, function paths, context, uncertainty, and diagnostics. The web interface provides source exploration, graph and finding views, kernel evaluation summaries, and report history. Separately, a userspace pthread harness records wrapper-level lock attempts, acquisitions, releases, thread identifiers, ordering, and timestamps in JSON Lines. It supports watchdog-terminated deadlock scenarios and static/runtime comparisons only when the user supplies an explicit lock-identity mapping.')

    h1('IV. EVALUATION METHOD')
    bodytext('Evaluation uses three evidence classes. Controlled C fixtures test expected extraction, dependency, negative, and inconclusive behavior. Pinned Linux translation units measure real-source parsing and analysis under recorded Kbuild flags. Historical cases compare source immediately before and after an upstream fix when reproducible inputs are available. A graph cycle or upstream bug report is not automatically counted as an IRQGuard detection; each case is classified from its raw output and coverage limitations.')
    h2('A. Controlled tests')
    bodytext('The versioned controlled set contains positive lock-order cases, negative cases such as mutually exclusive paths or release-before-next-acquire, and edge cases for wrappers, macros, saved IRQ state, symbolic identities, and incomplete evidence. The versioned Phase 17 dataset run passed eight fixture assertions with zero failures. The project also has CTest and web test suites; their historical run counts are not used as accuracy metrics here. These are regression outcomes on controlled inputs, not precision or recall estimates.')
    h2('B. Pinned Linux v6.6.87 source')
    bodytext('The real-source evaluation uses Linux stable v6.6.87, commit 814637ca257f4faf57a73fd4e38888cce88b5911, and five selected Intel e1000e translation units: netdev.c, ethtool.c, ich8lan.c, phy.c, and nvm.c [2]. Kbuild generated the compilation commands for x86_64_defconfig with CONFIG_E1000E=m. The recorded environment is Ubuntu 24.04 on WSL 2 with Clang/LLVM 20.1.2. This is a five-file experiment, not a whole-driver or whole-kernel call graph.')
    bodytext(f'Table II summarizes the fresh evaluation repeat. The analysis completed all five files and extracted {registration_count} resolved request_irq registration records. It produced no dependency edges or cycle findings. Therefore this scope cannot measure whether feasibility refinement reduces inconclusive cycle classifications. Diagnostics: {diagnostic_text}. Unknown calls and effects produced substantial uncertainty.')

    # IEEE-style table with template table styles.
    content.append(paragraph('TABLE II. SELECTED LINUX V6.6.87 EVALUATION RESULTS', 'tablehead'))
    table = ET.Element(q('tbl'))
    tblpr = ET.SubElement(table, q('tblPr'))
    style = ET.SubElement(tblpr, q('tblStyle')); style.set(q('val'), 'TableNormal')
    width = ET.SubElement(tblpr, q('tblW')); width.set(q('w'), '4860'); width.set(q('type'), 'dxa')
    layout = ET.SubElement(tblpr, q('tblLayout')); layout.set(q('type'), 'fixed')
    borders = ET.SubElement(tblpr, q('tblBorders'))
    for edge in ('top','left','bottom','right','insideH','insideV'):
        e=ET.SubElement(borders,q(edge)); e.set(q('val'),'nil' if edge in ('left','right','insideV') else 'single'); e.set(q('sz'),'7' if edge in ('top','bottom') else '4'); e.set(q('space'),'0'); e.set(q('color'),'777777')
    grid = ET.SubElement(table, q('tblGrid'))
    for w in ('2350','2510'):
        col=ET.SubElement(grid,q('gridCol')); col.set(q('w'),w)
    rows = [
        ('Measure','Recorded result'),
        ('Files and functions',f'{raw_eval["aggregate"]["files_analyzed"]} of {raw_eval["aggregate"]["files_requested"]}; {kernel_counts["functions"]} functions'),
        ('Calls',f'{call_count:,} extracted call records'),
        ('Lock operations',f'{kernel_counts["lock_operations"]} total; {kernel_counts["lock_acquisitions"]} acquisitions and {kernel_counts["lock_releases"]} releases'),
        ('Dependencies and cycles',f'{kernel_counts["lock_dependencies"]} dependencies; {kernel_counts["interrupt_graph_edges"]} interrupt edges; {kernel_counts["interrupt_cycles"]} cycles'),
        ('Uncertainty',f'{uncertainty_events:,} events; {uncertainty_records:,} unique records; {uncertainty_roots:,} root causes'),
        ('Diagnostics',f'{kernel_counts["diagnostics"]} parser or CFG diagnostics'),
        ('Time and memory',f'{kernel_seconds:.3f} s summed; {kernel_peak:,} KiB maximum per-process RSS'),
        ('Build coverage','Selected objects and objtool/ORC checks succeeded; no final module link; separate stack validation not configured'),
    ]
    for ri,rowdata in enumerate(rows):
        tr=ET.SubElement(table,q('tr'))
        for value in rowdata:
            tc=ET.SubElement(tr,q('tc'))
            tcpr=ET.SubElement(tc,q('tcPr')); tcw=ET.SubElement(tcpr,q('tcW')); tcw.set(q('w'),'2350' if len(tr)==1 else '2510'); tcw.set(q('type'),'dxa')
            p=ET.SubElement(tc,q('p')); ppr=ET.SubElement(p,q('pPr')); ps=ET.SubElement(ppr,q('pStyle')); ps.set(q('val'),'tablehead' if ri==0 else 'tablecopy')
            run=ET.SubElement(p,q('r')); t=ET.SubElement(run,q('t')); t.text=value
    content.append(table)
    content.append(paragraph('TABLE III. PER-FILE KERNEL MEASUREMENTS', 'tablehead'))
    file_table=ET.Element(q('tbl')); fpr=ET.SubElement(file_table,q('tblPr')); fw=ET.SubElement(fpr,q('tblW')); fw.set(q('w'),'4860'); fw.set(q('type'),'dxa'); fl=ET.SubElement(fpr,q('tblLayout')); fl.set(q('type'),'fixed')
    fb=ET.SubElement(fpr,q('tblBorders'))
    for edge in ('top','left','bottom','right','insideH','insideV'):
        e=ET.SubElement(fb,q(edge)); e.set(q('val'),'nil' if edge in ('left','right','insideV') else 'single'); e.set(q('sz'),'7' if edge in ('top','bottom') else '4'); e.set(q('space'),'0'); e.set(q('color'),'777777')
    fg=ET.SubElement(file_table,q('tblGrid'))
    for width_value in ('1510','750','700','950','950'):
        col=ET.SubElement(fg,q('gridCol')); col.set(q('w'),width_value)
    rows=[('File','Funcs','Ops','Time (s)','Peak RSS (MiB)')]
    for unit in raw_eval['translation_units']:
        counts=unit['counts']; rows.append((Path(unit['file']).name.removesuffix('.c'),str(counts['functions']),str(counts['lock_operations']),f"{unit['elapsed_seconds']:.3f}",f"{unit['peak_rss_kib']/1024:.1f}"))
    for ri,rowdata in enumerate(rows):
        tr=ET.SubElement(file_table,q('tr'))
        for ci,value in enumerate(rowdata):
            tc=ET.SubElement(tr,q('tc')); tcpr=ET.SubElement(tc,q('tcPr')); tcw=ET.SubElement(tcpr,q('tcW')); tcw.set(q('w'),('1510','750','700','950','950')[ci]); tcw.set(q('type'),'dxa')
            p=ET.SubElement(tc,q('p')); ppr=ET.SubElement(p,q('pPr')); jc=ET.SubElement(ppr,q('jc')); jc.set(q('val'),'center' if ci else 'left'); ps=ET.SubElement(ppr,q('pStyle')); ps.set(q('val'),'tablehead' if ri==0 else 'tablecopy')
            run=ET.SubElement(p,q('r')); t=ET.SubElement(run,q('t')); t.text=value
    content.append(file_table)
    content.append(paragraph(f'Per-file RSS is measured per analyzer process; {kernel_seconds:.3f} s is the sum of five separate process times.', 'figurecaption'))
    content.extend([paragraph('FIGURE 2. CONTROLLED INTERRUPT-AWARE LOCK CYCLE', 'figurecaption'), image_paragraph(LOCK_PNG, 'rId14', 'Controlled fixture lock cycle', 3000000, 'cross_a to cross_b to cross_a; process_cross_context to registered cross_handler; source lines 91, 48, and 49; potentially feasible fixture candidate'), paragraph('Extracted from tests/fixtures/interrupts.c and its saved Phase 17 JSON report: cross_a → cross_b (process_cross_context:91, cross_handler:48; registered at 75), then cross_b → cross_a (cross_handler:48–49). This potentially feasible fixture candidate is not a Linux-kernel finding or confirmed deadlock.', 'figurecaption')])
    content.extend([paragraph('FIGURE 3. UNCERTAINTY EVENTS BY FILE', 'figurecaption'), image_paragraph(EVAL_PNG, 'rId15', 'Uncertainty events across five e1000e files', 3000000), paragraph(f'Values are raw events from the pinned Linux v6.6.87 analysis, not unique bugs. The five files sum to {uncertainty_events:,} events.', 'figurecaption')])
    bodytext('The distribution is concentrated in netdev.c, which accounts for 24,685 events (67.9%); ich8lan.c contributes 6,396 (17.6%). The other three files together contribute 5,249 events. These values identify where review effort would be concentrated, but they are not normalized by file size or function count and should not be read as a comparison of defect rates.')
    bodytext(f'The aggregate uncertainty report separates {uncertainty_events:,} event occurrences into {uncertainty_records:,} unique records and {uncertainty_propagated:,} repeated propagation events. Those records contain {uncertainty_roots:,} root causes and linked secondary effects. No dependency edges or candidate cycles were produced in this kernel scope, so these uncertainties were not attached to a cycle finding. That absence does not establish that the analyzed code is deadlock-free; it describes the result under the current API, call-summary, and translation-unit coverage.')
    content.extend([paragraph('FIGURE 4. ANALYSIS TIME BY TRANSLATION UNIT', 'figurecaption'), image_paragraph(TIME_PNG, 'rId16', 'Analysis time across five e1000e files', 3000000), paragraph(f'Times are actual single-process elapsed times from the same pinned-source run; {kernel_seconds:.3f} s is the sum across separate analyzer processes.', 'figurecaption')])
    content.extend([paragraph('FIGURE 5. EXTRACTED LOCK OPERATIONS BY FILE', 'figurecaption'), image_paragraph(OPS_PNG, 'rId17', 'Lock acquisitions and releases per e1000e file', 3000000), paragraph('Bars show extracted acquisitions and releases (blue / orange); labels are acquisition count / release count. The sum is 6 / 6.', 'figurecaption')])
    content.extend([paragraph('FIGURE 6. UNCERTAINTY EVENTS BY CATEGORY', 'figurecaption'), image_paragraph(CAUSE_PNG, 'rId18', 'Uncertainty event categories', 3000000), paragraph('Interrupt-state effects and unresolved-call events overlap through propagated causes; categories are not independent bug counts.', 'figurecaption')])
    content.append(paragraph('TABLE IV. EVIDENCE SUMMARY', 'tablehead'))
    summary_table = ET.Element(q('tbl'))
    stpr=ET.SubElement(summary_table,q('tblPr')); stw=ET.SubElement(stpr,q('tblW')); stw.set(q('w'),'4860'); stw.set(q('type'),'dxa')
    slayout=ET.SubElement(stpr,q('tblLayout')); slayout.set(q('type'),'fixed')
    sborders=ET.SubElement(stpr,q('tblBorders'))
    for edge in ('top','left','bottom','right','insideH','insideV'):
        e=ET.SubElement(sborders,q(edge)); e.set(q('val'),'nil' if edge in ('left','right','insideV') else 'single'); e.set(q('sz'),'7' if edge in ('top','bottom') else '4'); e.set(q('space'),'0'); e.set(q('color'),'777777')
    sg=ET.SubElement(summary_table,q('tblGrid'))
    for width_value in ('1700','3160'):
        col=ET.SubElement(sg,q('gridCol')); col.set(q('w'),width_value)
    summary_rows=[('Evidence set','Measured result'),('Controlled fixtures','8 of 8 dataset assertions passed; not an accuracy metric'),('Linux v6.6.87','5 files; 396 functions; 12 lock operations; 0 dependencies and cycles'),('Historical cases','MIPS GIC: partial match; 8250 serial: miss'),('Runtime overhead','14,268 ns baseline vs 10,143,958 ns instrumented median; 70,995.86% in one WSL 2 sample'),('Detection accuracy','Not calculated; available kernel cases do not provide sufficient labeled ground truth')]
    for ri,rowdata in enumerate(summary_rows):
        tr=ET.SubElement(summary_table,q('tr'))
        for ci,value in enumerate(rowdata):
            tc=ET.SubElement(tr,q('tc')); tcpr=ET.SubElement(tc,q('tcPr')); tcw=ET.SubElement(tcpr,q('tcW')); tcw.set(q('w'),('1700','3160')[ci]); tcw.set(q('type'),'dxa')
            p=ET.SubElement(tc,q('p')); ppr=ET.SubElement(p,q('pPr')); ps=ET.SubElement(ppr,q('pStyle')); ps.set(q('val'),'tablehead' if ri==0 else 'tablecopy')
            run=ET.SubElement(p,q('r')); t=ET.SubElement(run,q('t')); t.text=value
    content.append(summary_table)

    h2('C. Historical case comparison')
    bodytext('The MIPS GIC case is an upstream-documented recursive acquisition of gic_lock. In the affected revision IRQGuard reported a gic_lock self-dependency from gic_set_affinity() to gic_set_type(), with acquisitions at lines 384 and 307 and a call at line 410. The cycle was classified inconclusive because the summary was uncertain. The adjacent fixed revision reported no cycle, but its guard(raw_spinlock_irqsave) operation was not extracted, so the fixed-side comparison has incomplete lock coverage. This is a partial match, not a confirmed runtime reproduction [3].')
    bodytext('The 8250 serial case is an upstream lockdep-reported inversion involving the port lock and IRQ descriptor or console paths. IRQGuard analyzed only 8250_port.c, left disable_irq_nosync() unresolved, and produced no dependencies or cycles in either revision (39 lock operations per translation unit). In the affected source, serial8250_do_startup() takes port->lock at line 2285 and calls disable_irq_nosync() at line 2287; the reverse IRQ-reporting and console path is outside the translation unit. This is a miss, and it remains visible in the full evaluation report [4]. The selected historical set is too small for accuracy metrics.')
    content.append(paragraph('TABLE V. HISTORICAL AND EXPLORATORY CASE OUTCOMES', 'tablehead'))
    case_table=ET.Element(q('tbl')); cpr=ET.SubElement(case_table,q('tblPr')); cw=ET.SubElement(cpr,q('tblW')); cw.set(q('w'),'4860'); cw.set(q('type'),'dxa'); cl=ET.SubElement(cpr,q('tblLayout')); cl.set(q('type'),'fixed')
    cb=ET.SubElement(cpr,q('tblBorders'))
    for edge in ('top','left','bottom','right','insideH','insideV'):
        e=ET.SubElement(cb,q(edge)); e.set(q('val'),'nil' if edge in ('left','right','insideV') else 'single'); e.set(q('sz'),'7' if edge in ('top','bottom') else '4'); e.set(q('space'),'0'); e.set(q('color'),'777777')
    cg=ET.SubElement(case_table,q('tblGrid'))
    for width_value in ('1550','3310'):
        el=ET.SubElement(cg,q('gridCol')); el.set(q('w'),width_value)
    case_rows=[('Case','IRQGuard result and limitation'),('MIPS GIC','Partial match: affected-version self-dependency is inconclusive; fixed-side guard lock extraction is incomplete.'),('8250 serial','Miss: disable_irq_nosync() is unresolved and the reverse lock path is outside the analyzed translation unit.')]
    for ri,rowdata in enumerate(case_rows):
        tr=ET.SubElement(case_table,q('tr'))
        for ci,value in enumerate(rowdata):
            tc=ET.SubElement(tr,q('tc')); tcpr=ET.SubElement(tc,q('tcPr')); tcw=ET.SubElement(tcpr,q('tcW')); tcw.set(q('w'),('1550','3310')[ci]); tcw.set(q('type'),'dxa')
            p=ET.SubElement(tc,q('p')); ppr=ET.SubElement(p,q('pPr')); ps=ET.SubElement(ppr,q('pStyle')); ps.set(q('val'),'tablehead' if ri==0 else 'tablecopy')
            run=ET.SubElement(p,q('r')); t=ET.SubElement(run,q('t')); t.text=value
    content.append(case_table)
    h2('D. Runtime instrumentation and overhead')
    bodytext('The runtime harness exercises safe ordering, opposite order, contention, and a reproducible userspace deadlock in a disposable process. A watchdog terminates the intentionally blocked process, and trace summaries distinguish an observed order cycle from a persistent wait-for cycle. Separate executions with opposite edge directions are not combined into a deadlock claim. One documented WSL 2 benchmark used 1,000 iterations and five repeats: the baseline median was 14,268 ns and the instrumented median was 10,143,958 ns, yielding 70,995.86 percent overhead under the documented formula. This unusually high value includes event serialization and flush costs and is a single machine-specific sample, not a general overhead estimate.')

    h1('V. RESULTS AND INTERPRETATION')
    bodytext('The controlled suite demonstrates that the analyzer can extract real lock calls, preserve macro and source provenance, propagate selected lock effects through wrappers, distinguish known negative fixtures, and report uncertainty for unsupported cases. The historical MIPS GIC comparison demonstrates one upstream-supported same-lock pattern in the affected source, but the analyzer labels it inconclusive and misses an operation in the fixed source. The 8250 case demonstrates a meaningful miss caused by unresolved API semantics and a cross-translation-unit path.')
    bodytext('On the selected e1000e files, zero graph edges and cycles are an absence of findings in this run, not evidence of deadlock freedom. The analysis is constrained by single-translation-unit scope, partial API modeling, function-summary uncertainty, alias limitations, and callback lifecycle gaps. The 36,330 uncertainty events are not 36,330 independent defects; the documented 2,431 root causes separate unique causes from linked secondary effects. No real-kernel precision, recall, false-positive rate, or false-negative rate is calculated because the selected files are not a labeled ground-truth set.')
    bodytext('The comparison with lockdep is qualitative. Lockdep observes lock classes and orders exercised by instrumented kernel executions and depends on execution coverage and configuration [5]. IRQGuard statically analyzes selected source paths but currently lacks broad kernel scope and API coverage. A lockdep report can supply independent evidence for a historical case, but a negative runtime observation cannot prove source-level absence. Likewise, userspace runtime evidence cannot validate a hard-IRQ scenario.')

    h1('VI. LIMITATIONS AND THREATS TO VALIDITY')
    bullet('Coverage: only one translation unit is analyzed per invocation. Calls, registrations, and lock paths crossing translation units may be absent.')
    bullet('Model: only selected lock and IRQ APIs are modeled. Wrappers, opaque macros, indirect calls, pointer aliases, CPU-hotplug semantics, softirqs, NMIs, and handler lifetimes can remain unresolved.')
    bullet('Feasibility: branch reasoning is bounded and supports only a small subset of predicates. It is not symbolic execution and is not a formal soundness proof.')
    bullet('Ground truth: the controlled fixtures validate expected behavior of the test suite; the kernel examples are few and incompletely labeled. The MIPS partial match and 8250 miss do not justify accuracy statistics.')
    bullet('Measurement: timings and memory are specific to the recorded WSL 2 setup. The runtime overhead sample is dominated by flush-heavy event output. The kernel object validation did not link the final module or run a kernel.')
    bullet('External validity: the results do not establish performance or effectiveness on other subsystems, kernel configurations, compiler versions, architectures, or the full Linux tree.')

    h1('VII. CONCLUSION AND FUTURE WORK')
    bodytext('IRQGuard provides a runnable, source-based foundation for studying interrupt-aware lock dependencies. It combines Clang extraction, symbolic identities, interprocedural summaries, selected Linux interrupt semantics, context-labelled dependency graphs, bounded feasibility checks, structured explanations, and a separate controlled userspace evidence harness. Current evidence supports the implementation on regression fixtures and a small number of pinned kernel cases, not kernel-wide deadlock detection. The MIPS GIC result is a partial match and the 8250 case is a miss.')
    bodytext('The highest-value next steps are to improve API and wrapper coverage, model context-sensitive dependencies that expose same-lock interrupt reentry, strengthen summary and alias reasoning without merging unrelated objects, retain causal uncertainty provenance, and rerun affected/fixed historical inputs with matching build databases. Larger Linux evaluations should follow only after bounded scopes produce reproducible findings. Independent validation and explicit uncertainty must remain part of every reported result.')

    h1('VIII. REPRODUCIBILITY')
    bodytext('Build the analyzer with cmake --build build -j2 and run ctest --test-dir build --output-on-failure from the repository root. Run the web checks from web with npm test and npm run build. For the pinned Linux scope, prepare the v6.6.87 checkout at commit 814637ca257f4faf57a73fd4e38888cce88b5911, then run python3 evaluation/run_kernel_eval.py --kernel third_party/linux-v6.6.87 --analyzer build/deadlock-analyzer --llvm /usr/lib/llvm-20/bin --output /tmp/irqguard-linux-rerun --jobs 2 --timeout 120. The historical pair uses python3 evaluation/prepare_historical_case.py and python3 evaluation/run_historical_case.py; the serial case has its own runner. Use a new output directory so saved evidence is not overwritten. Full dependency and source preparation instructions are in README.md and the linked evaluation reports.')
    content.append(paragraph('ACKNOWLEDGMENT', 'Heading5'))
    bodytext('The project uses the open-source Linux kernel and Clang/LLVM toolchain. No external funding is reported.')
    content.append(paragraph('REFERENCES', 'Heading5'))
    refs = [
        '[1] C. Ye, Y. Cai, and C. Zhang, “When Threads Meet Interrupts: Effective Static Detection of Interrupt-Based Deadlocks in the Linux Kernel,” in Proc. 33rd USENIX Security Symposium, 2024, pp. 6167-6184. [Online]. Available: https://www.usenix.org/system/files/usenixsecurity24-ye.pdf',
        '[2] Linux stable kernel, “Linux v6.6.87,” commit 814637ca257f4faf57a73fd4e38888cce88b5911. [Online]. Available: https://kernel.googlesource.com/pub/scm/linux/kernel/git/stable/linux/+/refs/tags/v6.6.87',
        '[3] Linux kernel tip, “irqchip/mips-gic: Fix recursive gic_lock acquisition,” commit 1bae25dcc6beb8b874f23601d2efa142ac4f9f36. [Online]. Available: https://git.kernel.org/tip/1bae25dcc6beb8b874f23601d2efa142ac4f9f36',
        '[4] Linux kernel, 8250 serial lock-order fix, commit 730037c3ee57f892e6df019bc88d417a5944737c. [Online]. Available: https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=730037c3ee57f892e6df019bc88d417a5944737c',
        '[5] Linux kernel documentation, “Lockdep design.” [Online]. Available: https://docs.kernel.org/locking/lockdep-design.html',
        '[6] LLVM Project, “LibTooling.” [Online]. Available: https://clang.llvm.org/docs/LibTooling.html',
        '[7] Linux kernel documentation, “Lock types and their rules.” [Online]. Available: https://docs.kernel.org/locking/locktypes.html. Accessed: Nov. 23, 2026.',
        '[8] Linux kernel documentation, “Unreliable Guide To Locking.” [Online]. Available: https://docs.kernel.org/kernel-hacking/locking.html. Accessed: Nov. 23, 2026.',
        '[9] LLVM Project, “Clang Internals Manual: Control-Flow Graphs.” [Online]. Available: https://clang.llvm.org/docs/InternalsManual.html. Accessed: Nov. 23, 2026.',
    ]
    for ref in refs: content.append(paragraph(ref, 'references'))

    # Pagination policy for the two-column paper: keep labels with the visual
    # or table that follows, keep figures with their explanatory caption, and
    # keep algorithm listings as compact units. Ordinary data tables remain
    # free to continue at the next column/page, but individual rows never split.
    def ensure_ppr(node):
        ppr=node.find('w:pPr',NS)
        if ppr is None:
            ppr=ET.Element(q('pPr')); node.insert(0,ppr)
        return ppr
    def set_pflag(node, flag):
        ppr=ensure_ppr(node)
        if ppr.find(f'w:{flag}',NS) is None: ET.SubElement(ppr,q(flag))
    for index,node in enumerate(content):
        if node.tag==q('p'):
            visible=''.join(t.text or '' for t in node.findall('.//w:t',NS)).strip()
            style=node.find('w:pPr/w:pStyle',NS)
            style_id=style.get(q('val')) if style is not None else ''
            if visible.startswith(('FIGURE ', 'TABLE ')) or style_id in ('Heading1','Heading2','Heading5'):
                set_pflag(node,'keepNext')
            if node.find('.//w:drawing',NS) is not None:
                set_pflag(node,'keepNext'); set_pflag(node,'keepLines')
        elif node.tag==q('tbl'):
            rows=node.findall('w:tr',NS)
            if rows:
                first_text=' '.join(t.text or '' for t in rows[0].findall('.//w:t',NS))
                is_algorithm=first_text.startswith(('Algorithm ', 'Listing '))
                header_row=any(c.find('.//w:pStyle[@w:val="tablehead"]',NS) is not None for c in rows[0].findall('w:tc',NS))
                if header_row:
                    trpr=rows[0].find('w:trPr',NS)
                    if trpr is None: trpr=ET.SubElement(rows[0],q('trPr'))
                    ET.SubElement(trpr,q('tblHeader'))
                for row in rows:
                    trpr=row.find('w:trPr',NS)
                    if trpr is None: trpr=ET.Element(q('trPr')); row.insert(0,trpr)
                    ET.SubElement(trpr,q('cantSplit'))
                    if is_algorithm:
                        # Keep the algorithm title with its first step and the
                        # final step with its explanation. Let intervening
                        # numbered rows flow naturally so a later algorithm
                        # does not get pushed to the next column, leaving a gap.
                        if row is rows[0]:
                            for p in row.findall('.//w:p',NS): set_pflag(p,'keepNext')
                        elif row is rows[-1]:
                            last_paragraphs=row.findall('.//w:p',NS)
                            if last_paragraphs: set_pflag(last_paragraphs[-1],'keepNext')
                        for p in row.findall('.//w:p',NS): set_pflag(p,'keepLines')

    # Rebuild document body while retaining the template's page/column section breaks.
    body.clear()
    body.append(title)
    body.append(first_section_break)
    body.append(author)
    body.append(affiliation)
    for p in author_breaks: body.append(p)
    for node in content: body.append(node)
    body.append(final_section_break)
    body.append(root_section)

    # Ensure author section is one column, while the final section break keeps IEEE body columns.
    # Serialize with original namespace prefixes, retaining the root's original namespace declarations.
    ET.register_namespace('w', W)
    serialized = ET.tostring(root, encoding='utf-8', xml_declaration=True)
    original_open = re.search(br'<w:document\b[^>]*>', doc_bytes).group(0)
    for prefix,uri in ((b'a',A.encode()),(b'pic',PIC.encode())):
        if b'xmlns:'+prefix+b'=' not in original_open:
            original_open=original_open[:-1]+b' xmlns:'+prefix+b'="'+uri+b'">'
    generated_open = re.search(br'<w:document\b[^>]*>', serialized).group(0)
    serialized = serialized.replace(generated_open, original_open, 1)

rels_ns={'rel':PKG_REL}; rels=ET.fromstring(next(d for i,d in entries if i.filename=='word/_rels/document.xml.rels'))
for old in list(rels):
    if old.get('Id') in {'rId13','rId14','rId15','rId16','rId17','rId18'}:
        rels.remove(old)
for rid,filename in [('rId13','media/irqguard-architecture.png'),('rId14','media/controlled-interrupt-lock-cycle.png'),('rId15','media/e1000e-uncertainty-events.png'),('rId16','media/e1000e-analysis-time.png'),('rId17','media/e1000e-lock-operations.png'),('rId18','media/e1000e-uncertainty-categories.png')]:
    ET.SubElement(rels,f'{{{PKG_REL}}}Relationship',{'Id':rid,'Type':R+'/image','Target':filename})
rels_bytes=ET.tostring(rels,encoding='utf-8',xml_declaration=True)
styles_root=ET.fromstring(next(d for i,d in entries if i.filename=='word/styles.xml'))
for style_id in ('BodyText','papertitle','Heading1','Heading2','Heading5','Abstract','Keywords','Author','Affiliation','figurecaption','tablehead','tablecopy','references','bulletlist'):
    style=styles_root.find(f".//w:style[@w:styleId='{style_id}']",NS)
    if style is None: continue
    # Section labels, table/figure captions, and bibliography numbers are
    # written explicitly in this report; disable the template's auto lists.
    if style_id in ('Heading1','Heading2','Heading5','figurecaption','tablehead','references'):
        ppr=style.find('w:pPr',NS)
        if ppr is not None:
            numpr=ppr.find('w:numPr',NS)
            if numpr is not None: ppr.remove(numpr)
    rpr=style.find('w:rPr',NS)
    if rpr is None: rpr=ET.SubElement(style,q('rPr'))
    fonts=rpr.find('w:rFonts',NS)
    if fonts is None: fonts=ET.SubElement(rpr,q('rFonts'))
    for key in ('ascii','hAnsi','eastAsia','cs'): fonts.set(q(key),'Times New Roman')
    if style_id=='BodyText':
        sz=rpr.find('w:sz',NS)
        if sz is None: sz=ET.SubElement(rpr,q('sz'))
        sz.set(q('val'),'22')
        ppr=style.find('w:pPr',NS)
        if ppr is not None:
            spacing=ppr.find('w:spacing',NS)
            if spacing is not None:
                spacing.set(q('line'),'13.2pt'); spacing.set(q('after'),'3pt')
    if style_id in ('Abstract','Heading1','Heading2','Heading5','figurecaption','tablehead','tablecopy','references'):
        sz=rpr.find('w:sz',NS)
        if sz is None: sz=ET.SubElement(rpr,q('sz'))
        sz.set(q('val'),{'Abstract':'20','Heading1':'22','Heading2':'20','Heading5':'18','figurecaption':'18','tablehead':'18','tablecopy':'18','references':'19'}[style_id])
        if style_id=='references':
            spacing=style.find('w:pPr/w:spacing',NS)
            if spacing is not None:
                spacing.set(q('line'),'11pt'); spacing.set(q('lineRule'),'auto'); spacing.set(q('after'),'2pt')
        if style_id=='figurecaption':
            ppr=style.find('w:pPr',NS)
            spacing=ppr.find('w:spacing',NS) if ppr is not None else None
            if spacing is not None:
                spacing.set(q('before'),'3pt'); spacing.set(q('after'),'4pt')
styles_bytes=ET.tostring(styles_root,encoding='utf-8',xml_declaration=True)
ctroot=ET.fromstring(next(d for i,d in entries if i.filename=='[Content_Types].xml'))
if not any(e.tag.endswith('Default') and e.get('Extension')=='png' for e in ctroot): ET.SubElement(ctroot,f'{{{CT}}}Default',{'Extension':'png','ContentType':'image/png'})
ctbytes=ET.tostring(ctroot,encoding='utf-8',xml_declaration=True)
with ZipFile(OUT, 'w', ZIP_DEFLATED) as zout:
    for item, data in entries:
        if item.filename in {'word/media/irqguard-architecture.png','word/media/controlled-interrupt-lock-cycle.png','word/media/e1000e-uncertainty-events.png','word/media/e1000e-analysis-time.png','word/media/e1000e-lock-operations.png','word/media/e1000e-uncertainty-categories.png'}:
            continue
        if item.filename == 'word/document.xml': data = serialized
        elif item.filename == 'word/_rels/document.xml.rels': data=rels_bytes
        elif item.filename == 'word/styles.xml': data=styles_bytes
        elif item.filename == '[Content_Types].xml': data=ctbytes
        zout.writestr(item, data)
    zout.write(ARCH_PNG,'word/media/irqguard-architecture.png')
    zout.write(LOCK_PNG,'word/media/controlled-interrupt-lock-cycle.png')
    zout.write(EVAL_PNG,'word/media/e1000e-uncertainty-events.png')
    zout.write(TIME_PNG,'word/media/e1000e-analysis-time.png')
    zout.write(OPS_PNG,'word/media/e1000e-lock-operations.png')
    zout.write(CAUSE_PNG,'word/media/e1000e-uncertainty-categories.png')
print(OUT)
print('paragraphs', len(content), 'tables', 9, 'figures', 6, 'pseudocode algorithms', 2, 'source listings', 1)
