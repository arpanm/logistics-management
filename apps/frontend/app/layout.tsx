import "./styles.css";
import { FormFeedbackBridge } from "../components/forms/form-feedback-bridge";
export const metadata = {
  title: "Logistics Control Tower",
  description: "Tenant-safe logistics operations",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <FormFeedbackBridge />
        {children}
      </body>
    </html>
  );
}
