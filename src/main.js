const BOILER_QUESTIONS = "https://api.boilerexams.com/questions/";

const isUUID = (pos_uuid) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pos_uuid);
const fetch_question = (question_id) => fetch(`${BOILER_QUESTIONS}${question_id}`);

const BOILER_TAI_BRAIN = "";

function get_question_id(url = window.location.href) {
  const tail_i = url.lastIndexOf('/');
  if (tail_i == -1)
    return null;
  const tail = url.substring(tail_i + 1);
  const query = tail.lastIndexOf('?');

  const pos_uuid = tail.substring(0, query == -1 ? tail.length : query);
  if (!isUUID(pos_uuid))
    return false;

  return pos_uuid;
}


const question_id = get_question_id();
fetch_question(question_id)
  .then(res => res.json())
  .then(json => console.log(json))
  .catch(error => console.log("Boiler TAI: WTF! This question isn't a question?! Please report this at *!"));