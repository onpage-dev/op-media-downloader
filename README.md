- questo programma deve poter sincronizzare in base al token api

- dopo che lo installi, puoi configurare diverse cartelle (es. /path1/dir1: contiene i file di token-api-1 e su /path2/dir2 ci configuro un altro token api)

- per capire quali file usare, bisogna fare il foreach delle raccolte per scaricarsi tutti i file

- per ogni config, ho 3 azioni: sync, modifica, elimina (dati+config)

- lo storage per salvare le config sarà un file locale nel computer dell'utente

- dato un PATH, i file devono essere salvati così:
  PATH/data/token-file
  (se esiste già il percorso, non serve riscaricarlo (perché il token è univoco))

PATH/nome-file.jpg
deve essere un link al file che sta dentro PATH/data/
potrebbe succedere che lo stesso file (token) è presente per più file anche con nomi diversi, quindi avrai
PATH/file1.jpg -> data/token-1
PATH/file2.jpg -> data/token-1
PATH/file3.jpg -> data/token-1

il fatto di averli come link ci consente di salvare il file una volta sola (altrimenti dovresti scaricarlo 3 volte per niente)

dati da salvare:

LocalStoreData {
configs: FolderConfigJson[]
}

interface SyncResult {
remote_files: OpFileRaw[]
local_files: OpFileRaw[]
start_time: string
end_time: string
}

class FolderConfigJson {
label: string (input utente)
api_token: string
folder_path: string
last_sync?: SyncResult
current_status?: SyncResult
async syncFiles() { ... }
}
