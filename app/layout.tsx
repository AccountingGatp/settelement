import "./globals.css";
export const metadata = { title: "Settlement Reconciliation", description: "Check settled sales and refunds in the settlement file against QuickBooks Online and correct the sales tax" };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
