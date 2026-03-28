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
        hover || onClick ? "hover:border-primary/30 hover:shadow-md cursor-pointer transition-all duration-200 active:scale-[0.98]" : ""
      } ${className}`}
    >
      {children}
    </div>
  );
}
