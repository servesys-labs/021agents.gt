interface CardProps {
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
  hover?: boolean;
}

export function Card({ children, className = "", onClick, hover }: CardProps) {
  return (
    <div
      onClick={onClick}
      className={`bg-white rounded-xl border border-border p-5 ${
        hover || onClick ? "hover:border-primary/30 hover:shadow-sm cursor-pointer transition-all" : ""
      } ${className}`}
    >
      {children}
    </div>
  );
}
