//Đăng kí
import type { Metadata } from "next";
import AuthForm from "../../components/AuthForm";

export const metadata: Metadata = { title: "Đăng ký | HelpMate" };

export default function RegisterPage() {
  return <AuthForm mode="register" />;
}
