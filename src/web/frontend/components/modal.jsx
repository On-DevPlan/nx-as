import { useEffect } from 'react';

// 通用模态弹窗：遮罩 + 居中 + Esc 关闭 + 点击遮罩关闭
// 主体内容（children）由调用方决定；不引第三方库；轻量 A02 风格
export function Modal({ open, onClose, title, children, maxWidth = 960 }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    // 打开时禁止 body 滚动，关闭恢复（避免双层滚动 + 视觉跳变）
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ maxWidth }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3 className="modal-title">{title}</h3>
          <button className="modal-close" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
