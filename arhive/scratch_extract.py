import sys
import zipfile
import xml.etree.ElementTree as ET

def extract_docx_text(docx_path):
    try:
        import docx
        doc = docx.Document(docx_path)
        text = []
        for p in doc.paragraphs:
            text.append(p.text)
        return "\n".join(text)
    except ImportError:
        try:
            with zipfile.ZipFile(docx_path) as docx_zip:
                xml_content = docx_zip.read('word/document.xml')
                root = ET.fromstring(xml_content)
                namespaces = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
                texts = []
                for elem in root.iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t'):
                    texts.append(elem.text)
                return "".join(texts)
        except Exception as e:
            return f"Error: {e}"

if __name__ == '__main__':
    path = "RBATPM Functional Requirements.docx"
    print(extract_docx_text(path))
