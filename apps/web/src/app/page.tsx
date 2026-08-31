import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'

export default async function Page() {

  const cookieStore = await cookies()
  const token = cookieStore.get('access_token')?.value

  redirect(token ? '/dashboard' : '/login')

}