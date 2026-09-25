// 基础组件：密度 28px 行 / 32px 按钮 / 12px 字号（A02 规范）
export function Card({ title, children }) {
  return (
    <section className="card">
      <h3 className="colhead">{title}</h3>
      {children}
    </section>
  );
}

export function Row({ label, children }) {
  return (
    <div className="row">
      {label ? <span className="rowlabel">{label}</span> : <span className="rowlabel" />}
      <span className="rowbody">{children}</span>
    </div>
  );
}

export function Btn({ children, onClick, disabled, className = '' }) {
  return (
    <button className={`btn ${className}`} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

export function Input({ value, onChange, placeholder, disabled }) {
  return (
    <input
      value={value ?? ''}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => onChange?.(e.target.value)}
    />
  );
}
