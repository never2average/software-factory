export default function Home() {
  return <main><h1>{process.env.NEXT_PUBLIC_PRODUCT_NAME ?? "Workspace"}</h1></main>;
}
