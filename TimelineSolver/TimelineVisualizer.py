import json
import os

# Try to import cairosvg, but don't crash if it's missing
try:
    import cairosvg
    HAS_CAIRO = True
except ImportError:
    HAS_CAIRO = False

def generate_svg_timeline(file_path):
    # 1. Define filenames immediately so they are always available
    base_name = os.path.splitext(file_path)[0]
    output_svg = f"{base_name}.svg"
    output_png = f"{base_name}.png"

    # 2. Load the JSON data
    try:
        with open(file_path, 'r') as f:
            wrapper = json.load(f)
    except Exception as e:
        print(f"❌ Error reading JSON file: {e}")
        return

    total_duration = wrapper.get('totalDuration', 24)
    data = wrapper.get('timeline', [])
    prompt_text = wrapper.get('prompt', 'Camera Timeline')

    # --- SVG Parameters ---
    WIDTH = 1400 
    HEIGHT = 550
    MARGIN = 100
    TIMELINE_Y = 400
    SCALE = (WIDTH - 2 * MARGIN) / total_duration

    colors = ["#3498db", "#e74c3c", "#2ecc71", "#f1c40f", "#9b59b6"]
    svg = [f'<svg width="{WIDTH}" height="{HEIGHT}" xmlns="http://www.w3.org/2000/svg">']
    svg.append('<rect width="100%" height="100%" fill="#f8f9fa" />') 
    
    # Title
    svg.append(f'<text x="{MARGIN}" y="40" font-family="Arial" font-size="16" fill="#333" font-weight="bold">Prompt: {prompt_text[:110]}...</text>')
    
    # Spine
    svg.append(f'<line x1="{MARGIN}" y1="{TIMELINE_Y}" x2="{WIDTH-MARGIN}" y2="{TIMELINE_Y}" stroke="#333" stroke-width="3" />')

    def format_params(loss):
        params = loss.get('parameters', {})
        if not params: return ""
        return f": {', '.join([str(v) for v in params.values()])}"

    color_idx = 0
    for segment in data:
        if segment['kind'] == 'point':
            x = MARGIN + (segment['time'] * SCALE)
            svg.append(f'<line x1="{x}" y1="{TIMELINE_Y}" x2="{x}" y2="{TIMELINE_Y - 140}" stroke="#c0392b" stroke-width="2" stroke-dasharray="4"/>')
            svg.append(f'<circle cx="{x}" cy="{TIMELINE_Y}" r="6" fill="#c0392b" />')
            
            for i, loss in enumerate(segment['lossFunctions']):
                label = f"{loss['type']}{format_params(loss)} ({segment['time']}s)"
                svg.append(f'<text x="{x}" y="{TIMELINE_Y - 150 - (i*20)}" font-family="Arial" font-size="11" text-anchor="middle" fill="#c0392b" font-weight="bold">{label}</text>')

        elif segment['kind'] == 'interval':
            s_t, e_t = segment['startTime'], segment['endTime']
            x_start = MARGIN + (s_t * SCALE)
            x_end = MARGIN + (e_t * SCALE)
            w = max(x_end - x_start, 2)
            color = colors[color_idx % len(colors)]
            color_idx += 1
            
            svg.append(f'<rect x="{x_start}" y="{TIMELINE_Y - 15}" width="{w}" height="30" fill="{color}" fill-opacity="0.7" stroke="white" stroke-width="1" rx="4" />')
            
            mid_x = x_start + (w / 2)
            for i, loss in enumerate(segment['lossFunctions']):
                label = f"{loss['type']}{format_params(loss)} [{s_t}s -> {e_t}s]"
                svg.append(f'<text x="{mid_x}" y="{TIMELINE_Y - 50 - (i*20)}" font-family="Arial" font-size="11" text-anchor="middle" fill="{color}" font-weight="bold">{label}</text>')

    # Time Ticks
    for t in range(0, int(total_duration) + 1):
        x = MARGIN + (t * SCALE)
        is_major = t % 5 == 0
        svg.append(f'<line x1="{x}" y1="{TIMELINE_Y}" x2="{x}" y2="{TIMELINE_Y + (15 if is_major else 8)}" stroke="#333" stroke-width="{2 if is_major else 1}" />')
        if is_major:
            svg.append(f'<text x="{x}" y="{TIMELINE_Y + 35}" font-family="Arial" font-size="12" text-anchor="middle" font-weight="bold">{t}s</text>')

    svg.append('</svg>')
    svg_content = "\n".join(svg)
    
    # 3. Save SVG
    try:
        with open(output_svg, "w") as f:
            f.write(svg_content)
        print(f"✅ SVG Generated: {output_svg}")
    except Exception as e:
        print(f"❌ Failed to save SVG: {e}")
        return

    # 4. Save PNG
    if HAS_CAIRO:
        try:
            cairosvg.svg2png(bytestring=svg_content.encode('utf-8'), write_to=output_png)
            print(f"🖼️  PNG Generated: {output_png}")
        except Exception as e:
            print(f"⚠️  PNG conversion failed (but SVG is saved): {e}")
    else:
        print("💡 Note: Install cairosvg (`pip install cairosvg`) to generate PNGs automatically.")

if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1:
        generate_svg_timeline(sys.argv[1])
    else:
        print("Usage: python3 visualizer.py <your_json_file>.json")