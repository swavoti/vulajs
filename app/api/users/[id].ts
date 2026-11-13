export async function GET(req: any, res: any) {
  const { id } = req.params;
  res.json({ message: "Hello user", id });
}
