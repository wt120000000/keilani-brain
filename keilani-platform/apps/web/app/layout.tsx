export const metadata = { title: "Keilani Platform" };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{background:"#0b0b0b",color:"#eee",fontFamily:"system-ui",padding:"24px"}}>
        {children}
      </body>
    </html>
  );
}