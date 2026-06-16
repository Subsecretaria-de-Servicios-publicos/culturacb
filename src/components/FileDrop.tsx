import { UploadCloud } from "lucide-react";

interface FileDropProps {
  label: string;
  description: string;
  file: File | null;
  onChange: (file: File | null) => void;
}

export function FileDrop({ label, description, file, onChange }: FileDropProps) {
  return (
    <label className="file-drop">
      <div className="file-icon"><UploadCloud size={28} /></div>
      <div>
        <strong>{label}</strong>
        <p>{description}</p>
        <span>{file ? file.name : "Seleccionar archivo .xlsx"}</span>
      </div>
      <input
        type="file"
        accept=".xlsx,.xls"
        onChange={(event) => onChange(event.target.files?.[0] ?? null)}
      />
    </label>
  );
}
