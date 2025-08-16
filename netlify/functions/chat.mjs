PS C:\Users\Primary\documents\ai\syntheticsyndicate\keilani\keilani-brain> # Sales offers grounding
PS C:\Users\Primary\documents\ai\syntheticsyndicate\keilani\keilani-brain> $chat = @{ userId="00000000-0000-0000-0000-000000000001"; message="Using the Sales & Monetization playbook, create 3 offers at $10, $50, and $200 with clear CTAs." } | ConvertTo-Json
PS C:\Users\Primary\documents\ai\syntheticsyndicate\keilani\keilani-brain> Invoke-RestMethod -Method Post -Uri "$Base/api/chat" -ContentType "application/json" -Body $chat
Invoke-RestMethod : The remote server returned an error: (500) Internal Server Error.
At line:1 char:1
+ Invoke-RestMethod -Method Post -Uri "$Base/api/chat" -ContentType "ap ...
+ ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : InvalidOperation: (System.Net.HttpWebRequest:HttpWebRequest) [Invoke-RestMethod], WebExc
   eption
    + FullyQualifiedErrorId : WebCmdletWebResponseException,Microsoft.PowerShell.Commands.InvokeRestMethodCommand

PS C:\Users\Primary\documents\ai\syntheticsyndicate\keilani\keilani-brain>
PS C:\Users\Primary\documents\ai\syntheticsyndicate\keilani\keilani-brain> # Copywriting hooks
PS C:\Users\Primary\documents\ai\syntheticsyndicate\keilani\keilani-brain> $chat = @{ userId="00000000-0000-0000-0000-000000000001"; message="From the Copywriting pack, write 5 hooks under 8 words about morning routines using AIDA." } | ConvertTo-Json
PS C:\Users\Primary\documents\ai\syntheticsyndicate\keilani\keilani-brain> Invoke-RestMethod -Method Post -Uri "$Base/api/chat" -ContentType "application/json" -Body $chat
Invoke-RestMethod : The remote server returned an error: (500) Internal Server Error.
At line:1 char:1
+ Invoke-RestMethod -Method Post -Uri "$Base/api/chat" -ContentType "ap ...
+ ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : InvalidOperation: (System.Net.HttpWebRequest:HttpWebRequest) [Invoke-RestMethod], WebExc
   eption
    + FullyQualifiedErrorId : WebCmdletWebResponseException,Microsoft.PowerShell.Commands.InvokeRestMethodCommand

PS C:\Users\Primary\documents\ai\syntheticsyndicate\keilani\keilani-brain>
PS C:\Users\Primary\documents\ai\syntheticsyndicate\keilani\keilani-brain> # SEO plan
PS C:\Users\Primary\documents\ai\syntheticsyndicate\keilani\keilani-brain> $chat = @{ userId="00000000-0000-0000-0000-000000000001"; message="Plan a 4-week content calendar around 'AI productivity' using the Content & SEO pack." } | ConvertTo-Json
PS C:\Users\Primary\documents\ai\syntheticsyndicate\keilani\keilani-brain> Invoke-RestMethod -Method Post -Uri "$Base/api/chat" -ContentType "application/json" -Body $chat
Invoke-RestMethod : The remote server returned an error: (500) Internal Server Error.
At line:1 char:1
+ Invoke-RestMethod -Method Post -Uri "$Base/api/chat" -ContentType "ap ...
+ ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : InvalidOperation: (System.Net.HttpWebRequest:HttpWebRequest) [Invoke-RestMethod], WebExc
   eption
    + FullyQualifiedErrorId : WebCmdletWebResponseException,Microsoft.PowerShell.Commands.InvokeRestMethodCommand

PS C:\Users\Primary\documents\ai\syntheticsyndicate\keilani\keilani-brain>
PS C:\Users\Primary\documents\ai\syntheticsyndicate\keilani\keilani-brain> # Memory policy check
PS C:\Users\Primary\documents\ai\syntheticsyndicate\keilani\keilani-brain> $chat = @{ userId="00000000-0000-0000-0000-000000000001"; message="Summarize our Memory Policy in one sentence, then list the 5 tags you'll use." } | ConvertTo-Json
PS C:\Users\Primary\documents\ai\syntheticsyndicate\keilani\keilani-brain> Invoke-RestMethod -Method Post -Uri "$Base/api/chat" -ContentType "application/json" -Body $chat
Invoke-RestMethod : The remote server returned an error: (500) Internal Server Error.
At line:1 char:1
+ Invoke-RestMethod -Method Post -Uri "$Base/api/chat" -ContentType "ap ...
+ ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : InvalidOperation: (System.Net.HttpWebRequest:HttpWebRequest) [Invoke-RestMethod], WebExc
   eption
    + FullyQualifiedErrorId : WebCmdletWebResponseException,Microsoft.PowerShell.Commands.InvokeRestMethodCommand