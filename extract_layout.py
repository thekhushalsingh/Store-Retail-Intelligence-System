import openpyxl
import zipfile, os, shutil

# The xlsx is just a zip — extract the media folder directly
src = r'c:\Users\khush\Downloads\zip\CCTV Footage\Brigade Road - Store layoutc5f5d56.xlsx'
out_dir = r'c:\Users\khush\Downloads\zip\CCTV Footage\layout_extracted'
os.makedirs(out_dir, exist_ok=True)

with zipfile.ZipFile(src, 'r') as z:
    for name in z.namelist():
        print(name)
        if name.startswith('xl/media/'):
            data = z.read(name)
            fname = os.path.basename(name)
            outpath = os.path.join(out_dir, fname)
            with open(outpath, 'wb') as f:
                f.write(data)
            print(f"  -> Saved {fname} ({len(data)} bytes)")
